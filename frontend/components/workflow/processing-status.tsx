"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import type { WorkflowStage } from "./types";

type ProcessingStatusProps = {
  stage: WorkflowStage;
  progress: number;
  phaseProgress?: {
    organize: number;
    alpha: number;
    inference: number;
  };
  logs: string[];
  canStart: boolean;
  isBusy: boolean;
  onStart: () => void;
  onReset: () => void;
  onCancel?: () => void;
  capabilities?: {
    gvm_installed: boolean;
    videomama_installed: boolean;
  };
};

const stageLabel: Record<WorkflowStage, string> = {
  idle: "Waiting for input",
  queued: "Job queued",
  processing: "Processing",
  complete: "Complete",
  error: "Error",
};

export function ProcessingStatus({
  stage,
  progress,
  phaseProgress,
  logs,
  canStart,
  isBusy,
  onStart,
  onReset,
  onCancel,
  capabilities,
}: ProcessingStatusProps) {
  const primaryAction = isBusy && onCancel ? onCancel : onStart;

  return (
    <section className="band reveal reveal-3">
      <h2>2. Process</h2>
      <p>
        Hit "Start Processing" to check all uploaded clips for processing. Only
        unprocessed clips will be submitted for processing.
      </p>

      {capabilities && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={capabilities.gvm_installed ? "success" : "warning"}>
            GVM: {capabilities.gvm_installed ? "Installed" : "Not Installed"}
          </Badge>
          <Badge
            variant={capabilities.videomama_installed ? "success" : "warning"}
          >
            VideoMaMa:{" "}
            {capabilities.videomama_installed ? "Installed" : "Not Installed"}
          </Badge>
        </div>
      )}

      <Card className="mt-4 bg-[rgba(255,255,255,0.04)]">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">{stageLabel[stage]}</span>
            <span className="font-mono text-[var(--ink-soft)]">
              {progress}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[rgba(255,255,255,0.12)]">
            <div
              className="h-full bg-[linear-gradient(90deg,var(--accent-a),var(--accent-b))] transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          {phaseProgress && (
            <div className="mt-4 grid gap-2 text-xs">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span>Organize</span>
                  <span>{phaseProgress.organize}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(255,255,255,0.12)]">
                  <div
                    className="h-full bg-[linear-gradient(90deg,#7dd3fc,#38bdf8)]"
                    style={{ width: `${phaseProgress.organize}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span>Alpha Generation</span>
                  <span>{phaseProgress.alpha}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(255,255,255,0.12)]">
                  <div
                    className="h-full bg-[linear-gradient(90deg,#86efac,#22c55e)]"
                    style={{ width: `${phaseProgress.alpha}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span>Inference</span>
                  <span>{phaseProgress.inference}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(255,255,255,0.12)]">
                  <div
                    className="h-full bg-[linear-gradient(90deg,#fda4af,#fb7185)]"
                    style={{ width: `${phaseProgress.inference}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={primaryAction}
              disabled={isBusy ? !onCancel : !canStart}
            >
              {isBusy ? "Stop Flow" : "Start Processing"}
            </Button>
            {!isBusy && (
              <Button type="button" variant="outline" onClick={onReset}>
                Reset Flow
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 rounded-xl border border-[var(--line)] bg-[rgba(2,8,24,0.55)] p-3">
        <p className="kicker">Activity Log</p>
        <ul className="mt-2 grid max-h-40 gap-1 overflow-auto pr-1 text-sm text-[var(--ink-soft)]">
          {logs.length === 0 && <li>No activity yet.</li>}
          {logs.map((log, i) => (
            <li key={`${log}-${i}`}>{log}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
