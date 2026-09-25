import { randomUUID } from 'node:crypto'
import type { OriginChannel } from './contracts.ts'

export type ApprovalAnswer = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export type ApprovalSettlement = ApprovalAnswer | 'expired'
export interface PendingApproval {
  id: string
  operationId?: string
  scopeSessionId?: string
  principalId: string
  originChannel: OriginChannel
  sessionId: string
  targetDeviceId: string
  toolName: string
  details: string
  expiresAt: number
}

/** Transport for live DSH questions, never a durable or reusable grant store. */
export class ApprovalInbox {
  private pending = new Map<string, { view: PendingApproval; finish: (answer: ApprovalAnswer, settlement?: ApprovalSettlement) => void }>()
  private listeners = new Set<(view: PendingApproval) => void | Promise<void>>()
  private settlements = new Set<(view: PendingApproval, answer: ApprovalSettlement) => void>()
  private closed = false

  constructor(private readonly ttlMs = 120_000) {}

  subscribe(listener: (view: PendingApproval) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  onSettled(listener: (view: PendingApproval, answer: ApprovalSettlement) => void): () => void {
    this.settlements.add(listener)
    return () => { this.settlements.delete(listener) }
  }

  list(principalId: string, originChannel: OriginChannel): PendingApproval[] {
    return [...this.pending.values()].map(entry => entry.view)
      .filter(view => view.principalId === principalId && view.originChannel === originChannel && view.expiresAt > Date.now())
      .map(view => ({ ...view }))
  }

  answer(id: string, principalId: string, originChannel: OriginChannel, allow: boolean): boolean {
    const entry = this.pending.get(id)
    if (!entry || entry.view.principalId !== principalId || entry.view.originChannel !== originChannel) return false
    if (entry.view.expiresAt <= Date.now()) { entry.finish('cancelled', 'expired'); return false }
    entry.finish(allow ? 'allowed-once' : 'rejected')
    return true
  }

  cancelSession(sessionId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.view.sessionId === sessionId) entry.finish('cancelled')
    }
  }

  ask(input: Omit<PendingApproval, 'id' | 'expiresAt'>, signal: AbortSignal): Promise<ApprovalAnswer> {
    if (this.closed || signal.aborted) return Promise.resolve('cancelled')
    if (this.pending.size >= 128) return Promise.resolve('unavailable')
    const view = Object.freeze({ ...input, id: randomUUID(), expiresAt: Date.now() + this.ttlMs })
    return new Promise(resolve => {
      const finish = (answer: ApprovalAnswer, settlement: ApprovalSettlement = answer) => {
        if (!this.pending.delete(view.id)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        for (const listener of this.settlements) listener(view, settlement)
        resolve(answer)
      }
      const onAbort = () => finish('cancelled')
      const timer = setTimeout(() => finish('cancelled', 'expired'), this.ttlMs)
      timer.unref()
      this.pending.set(view.id, { view, finish })
      signal.addEventListener('abort', onAbort, { once: true })
      for (const listener of this.listeners) {
        Promise.resolve().then(() => listener(view)).catch(() => finish('unavailable'))
      }
    })
  }

  close(): void {
    this.closed = true
    for (const entry of this.pending.values()) entry.finish('cancelled')
    this.listeners.clear()
    this.settlements.clear()
  }
}
