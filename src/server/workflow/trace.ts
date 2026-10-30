/**
 * Tool-call trace: every step of a check emits one event. Summaries are
 * factual (ids, counts, verdicts, timings) — never invented reasoning text.
 * The repair pipeline emits into the same collector as the sweep stages.
 */
export interface TraceEvent {
  seq: number;
  step: string;
  tool_or_model: string;
  input_summary: string;
  output_summary: string;
  duration_ms: number;
  evidence_ids: string[];
  next_state: string;
  cached: boolean;
}

export type TraceEventInput = Omit<TraceEvent, 'seq'>;

export class TraceCollector {
  private readonly events: TraceEvent[] = [];

  emit(event: TraceEventInput): TraceEvent {
    const full: TraceEvent = { ...event, seq: this.events.length + 1 };
    this.events.push(full);
    return full;
  }

  all(): TraceEvent[] {
    return [...this.events];
  }
}
