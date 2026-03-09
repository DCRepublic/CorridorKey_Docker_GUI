export type WorkflowStage =
  | "idle"
  | "queued"
  | "processing"
  | "complete"
  | "error";

export type OutputArtifact = {
  id: string;
  label: string;
  filename: string;
  description: string;
  category?: string;
  downloadUrl?: string;
  previewUrl?: string;
  previewType?: "video" | "image";
  isSequence?: boolean;
  outputType?: string;
};
