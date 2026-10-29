/**
 * Helpers for scripts/probe-meta-write.ts, kept here so they are unit-testable.
 */

/** Graph subcode Meta returns when it rejects the creative-enhancements opt-out. */
export const OPT_OUT_REJECTION_SUBCODE = 3858504;

export interface GraphErrorCode {
  code: number;
  error_subcode?: number;
}

/**
 * True when a Graph error rejects the degrees_of_freedom_spec opt-out.
 *
 * Detected by numeric codes only — never by message text, which Meta localizes
 * (e.g. Hebrew) and may not contain the English field names.
 *
 * @param error the Graph error body (or GraphApiError.body)
 * @param requestContainedOptOut whether the failed request carried degrees_of_freedom_spec
 */
export function isOptOutRejection(error: GraphErrorCode, requestContainedOptOut: boolean): boolean {
  if (error.error_subcode === OPT_OUT_REJECTION_SUBCODE) return true;
  return error.code === 100 && requestContainedOptOut;
}

/** Uploaded-image hash format: MD5 of the bytes, 32 lowercase hex chars (accept any case). */
const IMAGE_HASH_RE = /^[0-9a-fA-F]{32}$/;

export function isValidImageHash(value: string): boolean {
  return IMAGE_HASH_RE.test(value);
}

export type ProbeMode = 'dry-run' | 'execute';

export interface ParsedProbeArgs {
  mode: ProbeMode;
  imageHash: string | undefined;
  help: boolean;
}

export class ProbeArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeArgsError';
  }
}

/**
 * Parse probe-meta-write argv (without node/script name).
 * Throws ProbeArgsError on unknown flags, missing values, or a malformed --image-hash.
 */
export function parseProbeArgs(argv: string[]): ParsedProbeArgs {
  let mode: ProbeMode = 'dry-run';
  let imageHash: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--execute') {
      mode = 'execute';
    } else if (arg === '--image-hash') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new ProbeArgsError('--image-hash requires a value: --image-hash <32-hex-char-hash>');
      }
      i += 1;
      imageHash = requireValidImageHash(value);
    } else if (arg.startsWith('--image-hash=')) {
      const value = arg.slice('--image-hash='.length);
      if (!value) throw new ProbeArgsError('--image-hash requires a value: --image-hash <32-hex-char-hash>');
      imageHash = requireValidImageHash(value);
    } else {
      throw new ProbeArgsError(`Unknown flag: ${arg}`);
    }
  }

  return { mode, imageHash, help };
}

function requireValidImageHash(value: string): string {
  if (!isValidImageHash(value)) {
    throw new ProbeArgsError(`--image-hash must be 32 hex chars, got: ${JSON.stringify(value)}`);
  }
  return value;
}
