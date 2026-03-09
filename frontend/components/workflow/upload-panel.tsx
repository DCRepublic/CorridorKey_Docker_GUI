"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type UploadPanelProps = {
  files: File[];
  onFilesSelected: (files: File[]) => void;
  onClear: () => void;
  onUpload: () => void;
  isUploading: boolean;
  uploadError: string | null;
};

export function UploadPanel({
  files,
  onFilesSelected,
  onClear,
  onUpload,
  isUploading,
  uploadError,
}: UploadPanelProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const acceptFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const next = Array.from(incoming);
    if (next.length > 0) onFilesSelected(next);
  };

  return (
    <section className="band reveal reveal-2">
      <h2>1. Upload Source Clips</h2>
      <p>
        Add one or more source files. Uploaded files are copied into the clips
        directory for later processing.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          acceptFiles(e.dataTransfer.files);
        }}
        className="mt-4 rounded-xl border border-dashed border-[rgba(189,214,244,0.45)] bg-[rgba(255,255,255,0.04)] p-5"
      >
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          onChange={(e) => acceptFiles(e.target.files)}
        />

        <p className="text-sm text-[var(--ink-soft)]">
          {isDragging ? "Drop files to add them" : "Drag and drop files here"}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" onClick={() => inputRef.current?.click()}>
            Choose Files
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onClear}
            disabled={isUploading}
          >
            Clear
          </Button>
          <Button
            type="button"
            onClick={onUpload}
            disabled={isUploading || files.length === 0}
          >
            {isUploading ? "Uploading..." : "Upload to Clips Directory"}
          </Button>
        </div>

        {uploadError && (
          <p className="mt-3 text-sm text-red-300">{uploadError}</p>
        )}

        <ul className="mt-4 grid gap-2 text-sm">
          {files.length === 0 && (
            <li className="text-[var(--ink-soft)]">No files selected yet.</li>
          )}
          {files.map((file) => (
            <li key={`${file.name}-${file.size}`}>
              <Card>
                <CardContent className="px-3 py-2">
                  {file.name}{" "}
                  <span className="text-[var(--ink-soft)]">
                    ({Math.round(file.size / 1024 / 1024)} MB)
                  </span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
