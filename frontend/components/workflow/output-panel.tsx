"use client";

/* eslint-disable @next/next/no-img-element */

import type { OutputArtifact, WorkflowStage } from "./types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

type OutputPanelProps = {
  stage: WorkflowStage;
  previewUrl: string | null;
  previewType: "video" | "image" | null;
  outputs: OutputArtifact[];
  completedClips: Array<{ name: string; state: string }>;
  selectedOutputClip: string;
  onSelectOutputClip: (clipName: string) => void;
  onDownload: (artifact: OutputArtifact) => void | Promise<void>;
  onGeneratePreview?: (artifact: OutputArtifact) => void | Promise<void>;
  isLoadingOutputs?: boolean;
  downloadingArtifactId?: string | null;
  generatingPreviewArtifactId?: string | null;
};

export function OutputPanel({
  stage,
  previewUrl,
  previewType,
  outputs,
  completedClips,
  selectedOutputClip,
  onSelectOutputClip,
  onDownload,
  onGeneratePreview,
  isLoadingOutputs,
  downloadingArtifactId,
  generatingPreviewArtifactId,
}: OutputPanelProps) {
  const previewArtifacts = outputs.filter((o) => o.previewUrl && o.previewType);

  return (
    <section className="band reveal reveal-4">
      <h2>3. Preview and Download</h2>
      <p>
        Choose any finished clip to preview and download outputs at any time.
      </p>

      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
        <select
          value={selectedOutputClip}
          onChange={(e) => onSelectOutputClip(e.target.value)}
          className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.06)] px-3 py-2 text-sm"
        >
          {completedClips.length === 0 && (
            <option value="">No finished clips yet</option>
          )}
          {completedClips.map((clip) => (
            <option key={clip.name} value={clip.name}>
              {clip.name} ({clip.state})
            </option>
          ))}
        </select>
        <div className="flex items-center justify-end gap-2 text-xs text-[var(--ink-soft)] md:self-center">
          <span>Current flow stage: {stage}</span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardContent className="p-3">
            <p className="kicker">Preview</p>
            <div className="mt-2 min-h-[220px] rounded-lg border border-[rgba(189,214,244,0.24)] bg-[rgba(1,11,32,0.55)] p-2">
              {isLoadingOutputs && (
                <div className="flex h-[260px] items-center justify-center text-[var(--ink-soft)]">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Generating previews...
                </div>
              )}
              {!isLoadingOutputs && !previewUrl && (
                <p className="p-4 text-sm text-[var(--ink-soft)]">
                  Select a finished clip to preview outputs.
                </p>
              )}
              {!isLoadingOutputs && previewUrl && previewType === "video" && (
                <video
                  src={previewUrl}
                  controls
                  className="h-[260px] w-full rounded object-contain"
                />
              )}
              {!isLoadingOutputs && previewUrl && previewType === "image" && (
                <img
                  src={previewUrl}
                  alt="Upload preview"
                  className="h-[260px] w-full rounded object-contain"
                />
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3">
            <p className="kicker">Outputs</p>
            <ul className="mt-2 grid gap-2">
              {outputs.map((artifact) => (
                <li
                  key={artifact.id}
                  className="rounded-lg border border-[rgba(189,214,244,0.24)] bg-[rgba(1,11,32,0.5)] p-2"
                >
                  <p className="text-sm font-semibold">{artifact.label}</p>
                  <p className="text-xs text-[var(--ink-soft)]">
                    {artifact.description}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onDownload(artifact)}
                    disabled={downloadingArtifactId === artifact.id}
                    className="mt-2"
                  >
                    {downloadingArtifactId === artifact.id ? (
                      <>
                        <Loader2 className="mr-1 size-3 animate-spin" />
                        Preparing...
                      </>
                    ) : (
                      <>Download {artifact.filename}</>
                    )}
                  </Button>

                  {artifact.isSequence &&
                    !artifact.previewUrl &&
                    onGeneratePreview && (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => onGeneratePreview(artifact)}
                        disabled={generatingPreviewArtifactId === artifact.id}
                        className="mt-2 ml-2"
                      >
                        {generatingPreviewArtifactId === artifact.id ? (
                          <>
                            <Loader2 className="mr-1 size-3 animate-spin" />
                            Generating...
                          </>
                        ) : (
                          <>Generate Preview</>
                        )}
                      </Button>
                    )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardContent className="p-3">
          <p className="kicker">All Generated Previews</p>
          {isLoadingOutputs && (
            <div className="mt-3 flex items-center text-sm text-[var(--ink-soft)]">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Preparing preview tiles...
            </div>
          )}
          {!isLoadingOutputs && previewArtifacts.length === 0 && (
            <p className="mt-2 text-sm text-[var(--ink-soft)]">
              No generated previews available for this clip yet.
            </p>
          )}
          {!isLoadingOutputs && previewArtifacts.length > 0 && (
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {previewArtifacts.map((artifact) => (
                <div
                  key={`preview-${artifact.id}`}
                  className="rounded-lg border border-[rgba(189,214,244,0.24)] bg-[rgba(1,11,32,0.5)] p-2"
                >
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
                    {artifact.label}
                  </p>
                  {artifact.previewType === "video" ? (
                    <video
                      src={artifact.previewUrl}
                      controls
                      preload="metadata"
                      className="h-[180px] w-full rounded object-contain"
                    />
                  ) : (
                    <img
                      src={artifact.previewUrl}
                      alt={artifact.label}
                      className="h-[180px] w-full rounded object-contain"
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
