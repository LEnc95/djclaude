import { useEffect, useState } from "preact/hooks";
import QRCode from "qrcode";
import { Icon } from "./Icon";

interface Props {
  guestURL: string;
  eventName: string;
  venueName: string;
  code: string;
  large?: boolean;
}

function escapeHTML(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function RequestQRCode({
  guestURL,
  eventName,
  venueName,
  code,
  large = false,
}: Props) {
  const [qrDataURL, setQrDataURL] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(null);
    setQrDataURL("");
    QRCode.toDataURL(guestURL, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: large ? 12 : 8,
      color: {
        dark: "#050510",
        light: "#ffffff",
      },
    }).then(
      (url) => {
        if (alive) setQrDataURL(url);
      },
      () => {
        if (alive) setError("QR code could not be generated.");
      }
    );
    return () => {
      alive = false;
    };
  }, [guestURL, large]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  async function copyGuestURL() {
    try {
      await navigator.clipboard.writeText(guestURL);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function printQR() {
    if (!qrDataURL) return;
    const title = `${venueName} karaoke requests`;
    const win = window.open("", "djclaude-guest-qr", "width=720,height=900");
    if (!win) {
      window.print();
      return;
    }
    win.document.open();
    win.document.write(`<!doctype html>
<html>
  <head>
    <title>${escapeHTML(title)}</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #fff;
        color: #080812;
        font-family: Arial, Helvetica, sans-serif;
      }
      main {
        width: min(7.5in, calc(100vw - 48px));
        text-align: center;
        padding: 0.35in;
        border: 6px solid #080812;
      }
      h1 {
        margin: 0;
        font-size: 42px;
        line-height: 1.05;
        text-transform: uppercase;
      }
      h2 {
        margin: 12px 0 24px;
        font-size: 24px;
        font-weight: 700;
      }
      img {
        display: block;
        width: min(5in, 82vw);
        height: auto;
        margin: 0 auto 22px;
      }
      .code {
        display: inline-block;
        margin: 0 0 18px;
        padding: 10px 18px;
        border: 2px solid #080812;
        font-size: 28px;
        font-weight: 800;
        letter-spacing: 0.22em;
      }
      .url {
        overflow-wrap: anywhere;
        font-size: 16px;
      }
      @page { margin: 0.35in; }
    </style>
  </head>
  <body>
    <main>
      <h1>Scan to request a song</h1>
      <h2>${escapeHTML(venueName)} · ${escapeHTML(eventName)}</h2>
      <img src="${qrDataURL}" alt="Guest request QR code" />
      <div class="code">${escapeHTML(code)}</div>
      <div class="url">${escapeHTML(guestURL)}</div>
    </main>
    <script>
      window.addEventListener("load", () => {
        window.focus();
        setTimeout(() => window.print(), 150);
      });
    </script>
  </body>
</html>`);
    win.document.close();
  }

  const qrSize = large ? "w-72 h-72 md:w-96 md:h-96" : "w-56 h-56";

  return (
    <section class={`glass-panel rounded-xl p-md flex flex-col ${large ? "gap-md" : "gap-sm"} items-center text-center`}>
      <div class="flex items-center gap-sm">
        <Icon name="qr_code_2" class="text-tertiary text-3xl" />
        <h3 class="font-headline-md text-headline-md text-on-surface">
          Guest QR
        </h3>
      </div>

      <div class={`bg-white rounded-lg p-3 ${qrSize} flex items-center justify-center shadow-[0_0_24px_rgba(0,220,229,0.25)]`}>
        {qrDataURL ? (
          <img src={qrDataURL} alt="Guest request QR code" class="w-full h-full object-contain" />
        ) : (
          <span class="text-[#050510] font-label-caps text-label-caps">
            {error ?? "Generating…"}
          </span>
        )}
      </div>

      <div class="flex flex-col gap-xs">
        <span class="font-label-caps text-label-caps text-tertiary uppercase">
          Scan to request a song
        </span>
        <span class="font-body-md text-body-md text-on-surface">
          {venueName} · {eventName}
        </span>
        <span class="font-label-caps text-label-caps text-on-surface-variant">
          Code {code}
        </span>
      </div>

      <div class="w-full rounded-lg bg-surface-container-lowest/70 border border-white/10 px-3 py-2 font-body-md text-sm text-on-surface-variant break-all">
        {guestURL}
      </div>

      <div class="grid grid-cols-2 gap-sm w-full">
        <button
          type="button"
          onClick={copyGuestURL}
          class="h-11 rounded-lg flex items-center justify-center gap-2 font-label-caps text-label-caps font-bold bg-transparent border-2 border-tertiary text-tertiary hover:bg-tertiary/10 transition-colors"
        >
          <Icon name={copied ? "check" : "content_copy"} class="text-[18px]" />
          {copied ? "Copied" : "Copy link"}
        </button>
        <button
          type="button"
          onClick={printQR}
          disabled={!qrDataURL}
          class="btn-primary h-11 rounded-lg flex items-center justify-center gap-2 font-label-caps text-label-caps font-bold"
        >
          <Icon name="print" class="text-[18px]" />
          Print
        </button>
      </div>
    </section>
  );
}
