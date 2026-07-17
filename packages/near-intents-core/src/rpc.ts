/**
 * Minimal NEAR JSON-RPC client for the read path (view / `call_function`).
 *
 * The write path (`execute_intents` submission) lives in `signer.ts` and uses
 * `@near-js/*` for the transaction Borsh machinery; here we only need
 * finality-pinned function-call views, so a dependency-free `fetch` client keeps
 * the read path auditable and lets callers point at any RPC (FastNEAR default).
 */
import { bytesToUtf8, toBase64 } from "./bytes.js";
import { DEFAULT_NEAR_RPC_URL } from "./constants.js";

/** Error carrying the raw NEAR RPC error payload for diagnostics. */
export class NearRpcError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "NearRpcError";
  }
}

export type NearRpcOptions = {
  url?: string;
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Finality for view calls. `final` (default) is required for verification. */
  finality?: "final" | "optimistic";
};

export class NearRpc {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly finality: "final" | "optimistic";

  constructor(options: NearRpcOptions = {}) {
    this.url = options.url ?? DEFAULT_NEAR_RPC_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.finality = options.finality ?? "final";
  }

  /** Raw JSON-RPC call. Throws {@link NearRpcError} on transport or RPC error. */
  async rpc<T>(method: string, params: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "solvador", method, params }),
      });
    } catch (e) {
      throw new NearRpcError(`NEAR RPC transport error: ${errMsg(e)}`);
    }
    if (!res.ok) throw new NearRpcError(`NEAR RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: unknown };
    if (body.error !== undefined) {
      throw new NearRpcError("NEAR RPC returned error", body.error);
    }
    return body.result as T;
  }

  /**
   * Call a view (read-only) contract function and JSON-parse the result.
   *
   * @throws NearRpcError if the contract call surfaces an execution error.
   */
  async viewFunction<T>(contractId: string, methodName: string, args: unknown = {}): Promise<T> {
    const result = await this.rpc<{
      result?: number[];
      error?: string;
      logs?: string[];
    }>("query", {
      request_type: "call_function",
      finality: this.finality,
      account_id: contractId,
      method_name: methodName,
      args_base64: toBase64(new TextEncoder().encode(JSON.stringify(args))),
    });
    // A contract panic surfaces as `result.error` inside the query response.
    if (result.error) throw new NearRpcError(`${contractId}.${methodName}: ${result.error}`);
    if (!result.result) throw new NearRpcError(`${contractId}.${methodName}: empty result`);
    const text = bytesToUtf8(Uint8Array.from(result.result));
    return JSON.parse(text) as T;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
