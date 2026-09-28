/**
 * In-memory seam for workflow gate runtime state (ENG-34).
 * Durable/DB-backed store comes later — multi-process workers must inject a shared store.
 */

import type { ApprovalGateRecord, RetryGateRecord } from "./types.js";

export function workflowGateKey(taskId: string, gateId: string): string {
  return `${taskId}::${gateId}`;
}

export interface WorkflowGateStore {
  getApproval(taskId: string, gateId: string): ApprovalGateRecord | undefined;
  putApproval(record: ApprovalGateRecord): ApprovalGateRecord;
  getRetry(taskId: string, gateId: string): RetryGateRecord | undefined;
  putRetry(record: RetryGateRecord): RetryGateRecord;
  clear(taskId: string, gateId: string): void;
}

function cloneApproval(record: ApprovalGateRecord): ApprovalGateRecord {
  return {
    taskId: record.taskId,
    gateId: record.gateId,
    status: record.status,
    openedAt: record.openedAt,
    ...(record.comment !== undefined ? { comment: record.comment } : {}),
    ...(record.decidedAt !== undefined ? { decidedAt: record.decidedAt } : {}),
  };
}

function cloneRetry(record: RetryGateRecord): RetryGateRecord {
  return {
    taskId: record.taskId,
    gateId: record.gateId,
    stage: record.stage,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    updatedAt: record.updatedAt,
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
  };
}

export class InMemoryWorkflowGateStore implements WorkflowGateStore {
  private readonly approvals = new Map<string, ApprovalGateRecord>();
  private readonly retries = new Map<string, RetryGateRecord>();

  getApproval(taskId: string, gateId: string): ApprovalGateRecord | undefined {
    const row = this.approvals.get(workflowGateKey(taskId, gateId));
    return row ? cloneApproval(row) : undefined;
  }

  putApproval(record: ApprovalGateRecord): ApprovalGateRecord {
    const next = cloneApproval(record);
    this.approvals.set(workflowGateKey(record.taskId, record.gateId), next);
    return cloneApproval(next);
  }

  getRetry(taskId: string, gateId: string): RetryGateRecord | undefined {
    const row = this.retries.get(workflowGateKey(taskId, gateId));
    return row ? cloneRetry(row) : undefined;
  }

  putRetry(record: RetryGateRecord): RetryGateRecord {
    const next = cloneRetry(record);
    this.retries.set(workflowGateKey(record.taskId, record.gateId), next);
    return cloneRetry(next);
  }

  clear(taskId: string, gateId: string): void {
    const key = workflowGateKey(taskId, gateId);
    this.approvals.delete(key);
    this.retries.delete(key);
  }
}
