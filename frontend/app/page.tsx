"use client";

import { useEffect, useMemo, useState } from "react";

import { OutputPanel } from "@/components/workflow/output-panel";
import { ProcessingStatus } from "@/components/workflow/processing-status";
import type {
  OutputArtifact,
  WorkflowStage,
} from "@/components/workflow/types";
import { UploadPanel } from "@/components/workflow/upload-panel";

type ClipInfo = {
  name: string;
  state: string;
  input_frames?: number;
  alpha_frames?: number;
  has_alpha_frames?: boolean;
  mask_frames?: number;
  has_mask_frames?: boolean;
  has_outputs?: boolean;
};

type ApiJob = {
  job_id: string;
  clip_name: string;
  job_type: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  current_frame: number;
  total_frames: number;
  error_message?: string | null;
};

type OutputListResponse = {
  clip_name: string;
  outputs: Array<{
    type: string;
    filename: string;
    size_bytes: number;
    download_url: string;
    preview_url?: string | null;
    is_sequence?: boolean;
  }>;
};

type UploadResponse = {
  clips_dir: string;
  uploaded_count: number;
  files: Array<{
    original_name: string;
    saved_name: string;
    size_bytes: number;
  }>;
};

type Capabilities = {
  gvm_installed: boolean;
  videomama_installed: boolean;
};

const defaultOutputs: OutputArtifact[] = [
  {
    id: "matte",
    label: "Matte",
    filename: "matte.exr",
    description: "Linear alpha matte for compositing.",
  },
  {
    id: "fg",
    label: "Foreground",
    filename: "fg.exr",
    description: "Recovered straight foreground pass.",
  },
  {
    id: "processed",
    label: "Processed",
    filename: "processed.exr",
    description: "Premultiplied RGBA preview output.",
  },
  {
    id: "comp",
    label: "Comp Preview",
    filename: "comp.png",
    description: "Quick view render over checkerboard.",
  },
];

export default function Home() {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

  const [files, setFiles] = useState<File[]>([]);
  const [clipsDir, setClipsDir] = useState("/app/ClipsForInference");
  const [clips, setClips] = useState<ClipInfo[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [stage, setStage] = useState<WorkflowStage>("idle");
  const [progress, setProgress] = useState(0);
  const [phaseProgress, setPhaseProgress] = useState({
    organize: 0,
    alpha: 0,
    inference: 0,
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<OutputArtifact[]>(defaultOutputs);
  const [backendPreviewUrl, setBackendPreviewUrl] = useState<string | null>(
    null,
  );
  const [backendPreviewType, setBackendPreviewType] = useState<
    "video" | "image" | null
  >(null);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    gvm_installed: false,
    videomama_installed: false,
  });
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedOutputClip, setSelectedOutputClip] = useState("");
  const [isLoadingOutputs, setIsLoadingOutputs] = useState(false);
  const [downloadingArtifactId, setDownloadingArtifactId] = useState<
    string | null
  >(null);
  const [generatingPreviewArtifactId, setGeneratingPreviewArtifactId] =
    useState<string | null>(null);

  const addLog = (line: string) =>
    setLogs((prev) => [
      ...prev,
      `${new Date().toLocaleTimeString()} - ${line}`,
    ]);

  const completedClips = clips.filter(
    (c) => c.has_outputs === true || c.state === "COMPLETE",
  );

  const previewFile = files[0] ?? null;
  const previewType = previewFile
    ? previewFile.type.startsWith("video/")
      ? "video"
      : "image"
    : null;
  const previewUrl = useMemo(() => {
    if (!previewFile) return null;
    return URL.createObjectURL(previewFile);
  }, [previewFile]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    const run = async () => {
      try {
        const res = await fetch(`${apiBase}/health`);
        if (!res.ok) throw new Error(`Health check failed (${res.status})`);
        const json = (await res.json()) as { device?: string };
        addLog(`Backend online (${json.device ?? "unknown device"})`);

        const capsRes = await fetch(`${apiBase}/capabilities`);
        if (capsRes.ok) {
          const caps = (await capsRes.json()) as Capabilities;
          setCapabilities(caps);
          addLog(
            `Capabilities: GVM ${caps.gvm_installed ? "installed" : "not installed"}`,
          );
        }

        const scanRes = await fetch(
          `${apiBase}/scan?clips_dir=${encodeURIComponent(clipsDir)}`,
          { method: "POST" },
        );
        if (scanRes.ok) {
          const data = (await scanRes.json()) as ClipInfo[];
          setClips(data);
          if (data.length > 0) {
            const firstComplete =
              data.find((c) => c.state === "COMPLETE")?.name ?? data[0].name;
            setSelectedOutputClip(firstComplete);
            await loadOutputs(firstComplete);
          }
          addLog(`Initial scan complete: ${data.length} clip(s) discovered`);
        }
      } catch {
        addLog(
          "Backend unavailable. Start API server at http://localhost:8000",
        );
      }
    };
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const waitForJob = async (
    id: string,
    phase: "alpha" | "inference",
    phaseBasePercent: number,
    phaseStepPercent: number,
  ): Promise<ApiJob> => {
    // Poll until terminal state.
    for (;;) {
      const res = await fetch(`${apiBase}/jobs/${id}`);
      if (!res.ok) throw new Error(`Job polling failed (${res.status})`);
      const job = (await res.json()) as ApiJob;

      if (job.status === "running") {
        const inner =
          job.total_frames > 0
            ? Math.round(
                (job.current_frame / job.total_frames) * phaseStepPercent,
              )
            : 0;
        if (phase === "alpha") {
          setPhaseProgress((p) => ({
            ...p,
            alpha: Math.min(99, phaseBasePercent + inner),
          }));
        } else {
          setPhaseProgress((p) => ({
            ...p,
            inference: Math.min(99, phaseBasePercent + inner),
          }));
        }
      }

      if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "cancelled"
      ) {
        return job;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };

  const scanClips = async () => {
    try {
      addLog(`Scanning clips in ${clipsDir}`);
      const res = await fetch(
        `${apiBase}/scan?clips_dir=${encodeURIComponent(clipsDir)}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Scan failed (${res.status})`);
      const data = (await res.json()) as ClipInfo[];
      setClips(data);
      if (data.length > 0) {
        const nextOutput =
          selectedOutputClip &&
          data.some(
            (c) => c.name === selectedOutputClip && c.state === "COMPLETE",
          )
            ? selectedOutputClip
            : (data.find((c) => c.state === "COMPLETE")?.name ?? data[0].name);
        setSelectedOutputClip(nextOutput);
        await loadOutputs(nextOutput);
      }
      addLog(`Scan complete: ${data.length} clip(s) discovered`);
    } catch (e) {
      setStage("error");
      addLog(e instanceof Error ? e.message : "Scan failed");
    }
  };

  const uploadSelectedFiles = async () => {
    if (files.length === 0 || isUploading) return;
    setUploadError(null);
    setIsUploading(true);
    try {
      const form = new FormData();
      for (const file of files) form.append("files", file);

      const res = await fetch(
        `${apiBase}/uploads?clips_dir=${encodeURIComponent(clipsDir)}`,
        {
          method: "POST",
          body: form,
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload failed (${res.status}): ${text}`);
      }
      const data = (await res.json()) as UploadResponse;
      addLog(`Uploaded ${data.uploaded_count} file(s) to ${data.clips_dir}`);
      setFiles([]);
      await scanClips();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Upload failed";
      setUploadError(message);
      addLog(message);
    } finally {
      setIsUploading(false);
    }
  };

  const loadOutputs = async (clipName: string) => {
    if (!clipName) return;
    setIsLoadingOutputs(true);
    try {
      const res = await fetch(
        `${apiBase}/outputs/${encodeURIComponent(clipName)}`,
      );
      if (!res.ok) throw new Error(`Failed to list outputs (${res.status})`);
      const data = (await res.json()) as OutputListResponse;
      const mapped = data.outputs.map((o, idx) => {
        const isImagePreview =
          o.filename.toLowerCase().endsWith(".png") ||
          o.filename.toLowerCase().endsWith(".jpg") ||
          o.filename.toLowerCase().endsWith(".jpeg");

        const previewType: "video" | "image" | undefined = o.preview_url
          ? "video"
          : isImagePreview
            ? "image"
            : undefined;

        return {
          id: `${o.type}-${o.filename}-${idx}`,
          label: `${o.type.toUpperCase()} Output`,
          filename: o.filename,
          description: `${o.type} (${Math.max(1, Math.round(o.size_bytes / 1024))} KB)`,
          category: o.type,
          outputType: o.type,
          isSequence: Boolean(o.is_sequence),
          downloadUrl: `${apiBase}${o.download_url}`,
          previewUrl: o.preview_url
            ? `${apiBase}${o.preview_url}`
            : isImagePreview
              ? `${apiBase}${o.download_url}`
              : undefined,
          previewType,
        };
      });
      setOutputs(mapped.length > 0 ? mapped : defaultOutputs);

      const sequencePreview = mapped.find((m) => m.previewUrl);
      if (sequencePreview?.previewUrl) {
        setBackendPreviewUrl(sequencePreview.previewUrl);
        setBackendPreviewType("video");
        return;
      }

      const preview = mapped.find(
        (m) =>
          m.filename.toLowerCase().endsWith(".png") ||
          m.filename.toLowerCase().endsWith(".jpg"),
      );
      if (preview?.downloadUrl) {
        setBackendPreviewUrl(preview.downloadUrl);
        setBackendPreviewType("image");
      } else {
        setBackendPreviewUrl(null);
        setBackendPreviewType(null);
      }
    } catch (e) {
      addLog(e instanceof Error ? e.message : "Output listing failed");
    } finally {
      setIsLoadingOutputs(false);
    }
  };

  const onGeneratePreview = async (artifact: OutputArtifact) => {
    if (!selectedOutputClip || !artifact.outputType) return;
    setGeneratingPreviewArtifactId(artifact.id);
    try {
      const subdir = artifact.outputType.toUpperCase();
      const res = await fetch(
        `${apiBase}/outputs/${encodeURIComponent(selectedOutputClip)}/generate-preview?subdir=${encodeURIComponent(subdir)}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Generate preview failed (${res.status}): ${txt}`);
      }

      await loadOutputs(selectedOutputClip);
      addLog(`Preview generated for ${selectedOutputClip}/${subdir}`);
    } catch (e) {
      addLog(e instanceof Error ? e.message : "Preview generation failed");
    } finally {
      setGeneratingPreviewArtifactId(null);
    }
  };

  const onStart = () => {
    if (stage === "processing" || stage === "queued") return;

    const run = async () => {
      try {
        setStage("processing");
        setProgress(1);
        setPhaseProgress({ organize: 0, alpha: 0, inference: 0 });

        // 1) Organize clips like wizard does.
        addLog("Organizing dropped clips into shot folders...");
        const orgRes = await fetch(
          `${apiBase}/organize?clips_dir=${encodeURIComponent(clipsDir)}`,
          { method: "POST" },
        );
        if (!orgRes.ok) throw new Error(`Organize failed (${orgRes.status})`);
        setPhaseProgress((p) => ({ ...p, organize: 100 }));
        setProgress(10);

        // 2) Scan clips.
        addLog("Scanning clips after organization...");
        const scanRes = await fetch(
          `${apiBase}/scan?clips_dir=${encodeURIComponent(clipsDir)}`,
          { method: "POST" },
        );
        if (!scanRes.ok) throw new Error(`Scan failed (${scanRes.status})`);
        let scanned = (await scanRes.json()) as ClipInfo[];
        setClips(scanned);
        if (scanned.length === 0) {
          throw new Error(
            "No clips found after organization. Add source media first.",
          );
        }

        // 3) Generate missing AlphaHints.
        const alphaCandidates = scanned.filter((c) => {
          const inputFrames = c.input_frames ?? 0;
          const alphaFrames = c.alpha_frames ?? 0;
          // Generate if no alpha exists, or alpha is partial/incomplete.
          return inputFrames > 0 && alphaFrames < inputFrames;
        });
        if (alphaCandidates.length > 0) {
          addLog(
            `Generating missing AlphaHints for ${alphaCandidates.length} clip(s)...`,
          );

          for (let i = 0; i < alphaCandidates.length; i++) {
            const clip = alphaCandidates[i];
            const hasMask =
              (clip.mask_frames ?? 0) > 0 || clip.has_mask_frames === true;
            const endpoint = hasMask ? "videomama" : "gvm";

            if (endpoint === "videomama" && !capabilities.videomama_installed) {
              throw new Error(
                `VideoMaMa is not installed for masked clip ${clip.name}.`,
              );
            }
            if (endpoint === "gvm" && !capabilities.gvm_installed) {
              throw new Error(
                `GVM is not installed for unmasked clip ${clip.name}.`,
              );
            }

            addLog(
              `Generating AlphaHint for ${clip.name} via ${endpoint.toUpperCase()}...`,
            );
            const enqueue = await fetch(`${apiBase}/jobs/${endpoint}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ clip_name: clip.name }),
            });
            if (!enqueue.ok) {
              const msg = await enqueue.text();
              throw new Error(
                `Alpha generation queue failed (${enqueue.status}): ${msg}`,
              );
            }
            const job = (await enqueue.json()) as ApiJob;
            setJobId(job.job_id);
            const base = Math.round((i / alphaCandidates.length) * 100);
            const step = Math.max(1, Math.round(100 / alphaCandidates.length));
            const done = await waitForJob(job.job_id, "alpha", base, step);
            if (done.status !== "completed") {
              throw new Error(
                `Alpha generation failed for ${clip.name}: ${done.error_message ?? done.status}`,
              );
            }
            setPhaseProgress((p) => ({
              ...p,
              alpha: Math.min(100, base + step),
            }));
            addLog(
              `AlphaHint generated: ${clip.name} (${endpoint.toUpperCase()})`,
            );
          }
        } else {
          setPhaseProgress((p) => ({ ...p, alpha: 100 }));
          addLog("All clips already have AlphaHints.");
        }
        setProgress(55);

        // 4) Re-scan and run inference only on READY clips.
        const rescanRes = await fetch(
          `${apiBase}/scan?clips_dir=${encodeURIComponent(clipsDir)}`,
          { method: "POST" },
        );
        if (!rescanRes.ok)
          throw new Error(`Re-scan failed (${rescanRes.status})`);
        scanned = (await rescanRes.json()) as ClipInfo[];
        setClips(scanned);
        const ready = scanned.filter((c) => {
          if (c.state === "READY") return true;
          if (c.state === "COMPLETE") return false;
          const inputFrames = c.input_frames ?? 0;
          const alphaFrames = c.alpha_frames ?? 0;
          return inputFrames > 0 && alphaFrames > 0;
        });
        if (ready.length === 0) {
          throw new Error(
            "No READY clips found for inference after alpha generation.",
          );
        }

        addLog(`Running inference on ${ready.length} clip(s)...`);
        for (let i = 0; i < ready.length; i++) {
          const clip = ready[i];
          const enqueue = await fetch(`${apiBase}/jobs/inference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clip_name: clip.name, params: {} }),
          });
          if (!enqueue.ok) {
            const msg = await enqueue.text();
            throw new Error(
              `Inference queue failed (${enqueue.status}): ${msg}`,
            );
          }
          const job = (await enqueue.json()) as ApiJob;
          setJobId(job.job_id);
          const base = Math.round((i / ready.length) * 100);
          const step = Math.max(1, Math.round(100 / ready.length));
          const done = await waitForJob(job.job_id, "inference", base, step);
          if (done.status !== "completed") {
            throw new Error(
              `Inference failed for ${clip.name}: ${done.error_message ?? done.status}`,
            );
          }
          setPhaseProgress((p) => ({
            ...p,
            inference: Math.min(100, base + step),
          }));
          addLog(`Inference complete: ${clip.name}`);
        }

        setJobId(null);
        setStage("complete");
        setProgress(100);

        const previewClip =
          scanned.find((c) => c.state === "COMPLETE")?.name ?? scanned[0].name;
        setSelectedOutputClip(previewClip);
        await loadOutputs(previewClip);
        addLog("Pipeline complete. Outputs ready.");
      } catch (e) {
        setStage("error");
        setJobId(null);
        addLog(e instanceof Error ? e.message : "Failed to queue job");
      }
    };

    void run();
  };

  const onCancel = () => {
    if (!jobId) return;
    const run = async () => {
      try {
        await fetch(`${apiBase}/jobs/${jobId}/cancel`, { method: "POST" });
        addLog(`Cancel requested for job ${jobId}`);
        setStage("idle");
      } catch {
        addLog("Cancel request failed");
      }
    };
    void run();
  };

  const onReset = () => {
    setStage("idle");
    setProgress(0);
    setJobId(null);
    setPhaseProgress({ organize: 0, alpha: 0, inference: 0 });
    setBackendPreviewUrl(null);
    setBackendPreviewType(null);
  };

  const onClearFiles = () => {
    setFiles([]);
    setBackendPreviewUrl(null);
    setBackendPreviewType(null);
  };

  const onDownload = async (artifact: OutputArtifact) => {
    if (!artifact.downloadUrl) {
      addLog(`No API download URL for ${artifact.label}`);
      return;
    }

    setDownloadingArtifactId(artifact.id);
    try {
      const res = await fetch(artifact.downloadUrl);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = artifact.filename;
      a.click();
      URL.revokeObjectURL(url);
      addLog(`Downloading ${artifact.filename}`);
    } catch (e) {
      addLog(
        e instanceof Error
          ? e.message
          : `Download failed: ${artifact.filename}`,
      );
    } finally {
      setDownloadingArtifactId(null);
    }
  };

  return (
    <>
      <div className="gradient-shell" aria-hidden>
        <div className="gradient-orb orb-a" />
        <div className="gradient-orb orb-b" />
        <div className="gradient-orb orb-c" />
      </div>

      <main className="landing">
        <header className=" reveal reveal-1">
          <h1 className="headline">
            <span className="headline-gradient">CorridorKey.</span>
            <br />
          </h1>
        </header>

        <div className="narrative">
          <UploadPanel
            files={files}
            onFilesSelected={setFiles}
            onClear={onClearFiles}
            onUpload={() => void uploadSelectedFiles()}
            isUploading={isUploading}
            uploadError={uploadError}
          />

          <ProcessingStatus
            stage={stage}
            progress={progress}
            phaseProgress={phaseProgress}
            logs={logs}
            canStart={clipsDir.length > 0}
            isBusy={stage === "queued" || stage === "processing"}
            onStart={onStart}
            onReset={onReset}
            onCancel={onCancel}
            capabilities={capabilities}
          />

          <OutputPanel
            stage={stage}
            previewUrl={backendPreviewUrl ?? previewUrl}
            previewType={backendPreviewType ?? previewType}
            outputs={outputs}
            completedClips={completedClips}
            selectedOutputClip={selectedOutputClip}
            onSelectOutputClip={(name) => {
              setSelectedOutputClip(name);
              void loadOutputs(name);
            }}
            isLoadingOutputs={isLoadingOutputs}
            downloadingArtifactId={downloadingArtifactId}
            generatingPreviewArtifactId={generatingPreviewArtifactId}
            onGeneratePreview={onGeneratePreview}
            onDownload={onDownload}
          />
        </div>
      </main>
    </>
  );
}
