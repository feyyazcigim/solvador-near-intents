import { useEffect, useState } from "react";
import { fromAtomicUnits } from "@solvador/near-intents-core";
import {
  fundDeposit,
  getConfig,
  getStatus,
  requestQuote,
  verifyReceipt,
  type IssuedQuote,
  type PaywallConfig,
  type ReceiptVerification,
} from "./lib/api";
import {
  connect,
  connectedAccount,
  hasProvider,
  onAccountsChanged,
  signUsdcTransferAuthorization,
  sleep,
} from "./lib/eth";
import { unlockPremium, type UnlockResult } from "./lib/pay";

/** The 402 payload the server injects into the paywall HTML (when present). */
type InjectedPaymentRequired = {
  accepts?: Array<{ amount: string; asset: string; payTo: string; network: string; scheme: string }>;
};

declare global {
  interface Window {
    __X402_PAYMENT_REQUIRED__?: InjectedPaymentRequired;
  }
}

type PayPhase =
  | { phase: "idle" }
  | { phase: "quoting" }
  | { phase: "signature"; quote: IssuedQuote }
  | { phase: "funding"; quote: IssuedQuote }
  | { phase: "bridging"; quote: IssuedQuote; baseTx: string; status: string }
  | { phase: "unlocking"; quote: IssuedQuote; baseTx: string }
  | { phase: "done"; result: UnlockResult }
  | { phase: "error"; error: string };

const short = (s: string, n = 10) => (s.length <= 2 * n ? s : `${s.slice(0, n)}…${s.slice(-n)}`);

export default function App() {
  const injected = window.__X402_PAYMENT_REQUIRED__;
  const [config, setConfig] = useState<PaywallConfig>();
  const [account, setAccount] = useState<string>();
  const [pay, setPay] = useState<PayPhase>({ phase: "idle" });
  const [receiptCheck, setReceiptCheck] = useState<ReceiptVerification | "pending">();
  const [connectError, setConnectError] = useState<string>();

  const decimals = config?.price.decimals ?? 6;
  const accepted = injected?.accepts?.[0];
  const priceAtomic = accepted?.amount ?? config?.price.amount;
  const payTo = accepted?.payTo ?? config?.payTo;
  const priceDisplay = priceAtomic ? `$${fromAtomicUnits(BigInt(priceAtomic), decimals)}` : "…";
  const unlocked = pay.phase === "done";
  const paying = pay.phase !== "idle" && pay.phase !== "error" && !unlocked;

  useEffect(() => {
    getConfig().then(setConfig).catch(() => undefined);
    // Reconnect silently on refresh if the wallet already authorized this site.
    connectedAccount().then((a) => a && setAccount((prev) => prev ?? a));
  }, []);

  useEffect(
    () =>
      onAccountsChanged((accounts) => {
        setAccount(accounts[0]);
        setPay({ phase: "idle" });
      }),
    [],
  );

  const handleConnect = async () => {
    setConnectError(undefined);
    try {
      setAccount(await connect());
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    }
  };

  const handlePay = async () => {
    if (!account) return;
    setReceiptCheck(undefined);
    try {
      // 1) EXACT_OUTPUT quote: merchant receives the price; we pay quote.amountIn.
      setPay({ phase: "quoting" });
      const quote = await requestQuote(account);
      const amountIn = BigInt(quote.amountIn);

      // 2) ONE typed-data signature — no transaction, no gas, no chain switch.
      setPay({ phase: "signature", quote });
      const authorization = await signUsdcTransferAuthorization(
        account,
        quote.depositAddress,
        amountIn,
      );

      // 3) The facilitator broadcasts it on Base (relayer pays gas), then we
      //    poll 1Click to SUCCESS.
      setPay({ phase: "funding", quote });
      const { txHash: baseTx } = await fundDeposit(quote.depositAddress, authorization);
      setPay({ phase: "bridging", quote, baseTx, status: "PENDING_DEPOSIT" });
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        const s = await getStatus(quote.depositAddress).catch(() => undefined);
        if (s) {
          if (s.status === "SUCCESS") break;
          if (s.status === "REFUNDED" || s.status === "FAILED") {
            throw new Error(`1Click reported ${s.status} — nothing was charged beyond the refund fee.`);
          }
          setPay({ phase: "bridging", quote, baseTx, status: s.status });
        }
        if (Date.now() > deadline) {
          throw new Error("1Click is taking unusually long — your funds are safe; check again shortly.");
        }
        await sleep(3_000);
      }

      // 4) x402: present the deposit as payment; facilitator re-checks with 1Click.
      setPay({ phase: "unlocking", quote, baseTx });
      const result = await unlockPremium(quote.depositAddress, baseTx);
      setPay({ phase: "done", result });
    } catch (e) {
      setPay({ phase: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleVerifyReceipt = async () => {
    if (pay.phase !== "done") return;
    const receipt = pay.result.settle?.extra?.receipt;
    if (!receipt) return;
    setReceiptCheck("pending");
    try {
      setReceiptCheck(await verifyReceipt(receipt));
    } catch (e) {
      setReceiptCheck({ valid: false, reason: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="layout">
      <div className="pane-left">
        <div className="wordmark">Solvador</div>

        {!unlocked ? (
          <>
            <div className="eyebrow">x402 · multichain-exact</div>
            <h1>Premium signal</h1>
            <p className="subhead">
              Unlock for <strong>{priceDisplay}</strong> — pay with USDC on <strong>Base</strong>;
              the exact amount lands directly at <strong>{payTo ?? "…"}</strong> via NEAR Intents.
              <strong> One signature, zero gas</strong> — no transaction, no NEAR account.
            </p>

            {/* Step 1 — wallet */}
            <div className="card">
              <div className="step-title">
                <span className="step-num">01</span> Connect wallet
              </div>
              {!account ? (
                <>
                  <button className="btn" onClick={handleConnect} disabled={!hasProvider()}>
                    {hasProvider() ? "Connect wallet" : "No EVM wallet detected"}
                  </button>
                  {connectError && <div className="error-box">{connectError}</div>}
                  {!hasProvider() && (
                    <p className="hint">Install MetaMask (or any injected wallet) and reload.</p>
                  )}
                </>
              ) : (
                <div className="chip">
                  <span className="dot ok" />
                  <span className="addr">{account.toLowerCase()}</span>
                </div>
              )}
            </div>

            {/* Step 2 — pay */}
            {account && (
              <div className="card">
                <div className="step-title">
                  <span className="step-num">02</span> Pay from Base
                </div>
                <button className="btn" onClick={handlePay} disabled={paying}>
                  {pay.phase === "idle" || pay.phase === "error"
                    ? `Pay ${priceDisplay} — one signature, zero gas`
                    : "Payment in progress…"}
                </button>

                {pay.phase === "quoting" && (
                  <div className="status-line">
                    <span className="dot pulse" /> fetching an exact-output quote…
                  </div>
                )}
                {pay.phase === "signature" && (
                  <>
                    <QuoteRows quote={pay.quote} />
                    <div className="status-line">
                      <span className="dot pulse" /> sign the authorization in your wallet (no
                      transaction, no gas)…
                    </div>
                  </>
                )}
                {pay.phase === "funding" && (
                  <>
                    <QuoteRows quote={pay.quote} />
                    <div className="status-line">
                      <span className="dot pulse" /> facilitator is broadcasting your authorization
                      on Base…
                    </div>
                  </>
                )}
                {pay.phase === "bridging" && (
                  <>
                    <QuoteRows quote={pay.quote} />
                    <div className="status-line">
                      <span className="dot pulse" /> 1Click {pay.status.toLowerCase().replace(/_/g, " ")}…
                      (≈{pay.quote.timeEstimate}s)
                    </div>
                  </>
                )}
                {pay.phase === "unlocking" && (
                  <div className="status-line">
                    <span className="dot pulse" /> delivered — unlocking the content…
                  </div>
                )}
                {pay.phase === "error" && <div className="error-box">{pay.error}</div>}

                <p className="hint">
                  You sign one EIP-3009 authorization ("move {`amountIn`} USDC to this one-time
                  deposit address") — the facilitator pays the Base gas, 1Click delivers the exact
                  price to the merchant, and failed deposits auto-refund to your address. Your
                  wallet needs USDC on Base but zero ETH.
                </p>
              </div>
            )}
          </>
        ) : (
          <UnlockedView
            result={(pay as Extract<PayPhase, { phase: "done" }>).result}
            receiptCheck={receiptCheck}
            onVerify={handleVerifyReceipt}
          />
        )}

        <div className="spacer" />
        <div className="footer">
          multichain-exact · near:mainnet · settled by the Solvador facilitator via 1Click
          <br />
          proof = 1Click's signed execution status
        </div>
      </div>
    </div>
  );
}

function QuoteRows({ quote }: { quote: IssuedQuote }) {
  return (
    <div style={{ marginTop: "0.75rem" }}>
      <div className="row">
        <span className="label">You send (Base USDC)</span>
        <span className="value">{quote.amountInFormatted}</span>
      </div>
      <div className="row">
        <span className="label">Merchant receives</span>
        <span className="value">{quote.recipient}</span>
      </div>
      <div className="row">
        <span className="label">Deposit address</span>
        <span className="value">{short(quote.depositAddress, 8)}</span>
      </div>
    </div>
  );
}

function UnlockedView({
  result,
  receiptCheck,
  onVerify,
}: {
  result: UnlockResult;
  receiptCheck: ReceiptVerification | "pending" | undefined;
  onVerify: () => void;
}) {
  const content = result.content as {
    report?: { title?: string; pair?: string; verdict?: string; note?: string };
  };
  const settle = result.settle;
  const tx = settle?.transaction;
  const receipt = settle?.extra?.receipt as
    | { status?: string; quoteSignature?: string; depositAddress?: string }
    | undefined;

  return (
    <>
      <div className="eyebrow">unlocked · paid content</div>
      <h1>{content.report?.title ?? "Premium content"}</h1>
      <div className="premium-verdict">
        {content.report?.pair} {content.report?.verdict}
      </div>
      <p className="subhead">{content.report?.note}</p>

      <div className="card">
        <div className="eyebrow muted">settlement receipt · 1click signed status</div>
        <div className="code-card">
          <div>
            <span className="k">payer&nbsp;&nbsp;&nbsp;&nbsp;</span>
            <span className="v">{settle?.payer ?? "—"}</span>
          </div>
          <div>
            <span className="k">status&nbsp;&nbsp;&nbsp;</span>
            {receipt?.status ?? "—"}
          </div>
          <div>
            <span className="k">deposit&nbsp;&nbsp;</span>
            {receipt?.depositAddress ? short(receipt.depositAddress, 8) : "—"}
          </div>
          <div>
            <span className="k">tx&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
            {tx ? (
              <a href={`https://nearblocks.io/txns/${tx}`} target="_blank" rel="noreferrer">
                {short(tx, 12)}
              </a>
            ) : (
              "—"
            )}
          </div>
          <div>
            <span className="k">1click sig </span>
            {receipt?.quoteSignature ? short(receipt.quoteSignature, 10) : "—"}
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", alignItems: "center" }}>
          <button
            className="btn ghost"
            onClick={onVerify}
            disabled={!settle?.extra?.receipt || receiptCheck === "pending"}
          >
            {receiptCheck === "pending" ? "Verifying…" : "Verify receipt"}
          </button>
          {receiptCheck && receiptCheck !== "pending" && (
            <span className={receiptCheck.valid ? "check" : "status-line error"}>
              {receiptCheck.valid ? "✓ terms + signed status verified" : `✗ ${receiptCheck.reason}`}
            </span>
          )}
        </div>
        <p className="hint">
          Verification checks 1Click's signed execution status AND that its recorded terms pay this
          merchant's exact price — the @solvador/near-receipt merchant check.
        </p>
      </div>
    </>
  );
}
