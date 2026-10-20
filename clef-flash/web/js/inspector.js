// Inspector drawer: backend details, the last raw response, and copyable request snippets.

import { $, copyText, h, ms, toast } from "./ui.js";

const IMAGE_PLACEHOLDER = "data:image/jpeg;base64,<BASE64_JPEG>";

const shellQuote = (text) => `'${text.replace(/'/g, "'\\''")}'`;

export class Inspector {
  constructor({ getRequest }) {
    this.getRequest = getRequest; // () => {questions, state, hasImage}
    this.last = null;
    this.engine = null;
    this.visible = false;
    for (const button of document.querySelectorAll("[data-snippet]")) {
      button.addEventListener("click", async () => {
        const ok = await copyText(this.snippet(button.dataset.snippet));
        toast(ok ? "Copied to the clipboard" : "Copy failed", { kind: ok ? "ok" : "error" });
      });
    }
  }

  setVisible(visible) {
    this.visible = visible;
    if (visible) this.render();
  }

  setEngine(engine) {
    this.engine = engine;
    if (this.visible) this.render();
  }

  setResult(result) {
    this.last = result;
    if (this.visible) this.render();
  }

  render() {
    const e = this.engine;
    const rows = e
      ? [
          ["Status", e.status + (e.error ? ` · ${e.error}` : "")],
          ["Backend", e.backend + (e.synthetic ? " (synthetic answers)" : "")],
          ["Model", e.model],
          ["Running on", e.where],
          ...(e.device ? [["Device", `${e.device}${e.dtype ? ` · ${e.dtype}` : ""}`]] : []),
          ...(e.notes || []).map((note, i) => [i ? "" : "Notes", note]),
          ["Largest side", `${e.limits?.max_side ?? "–"} px`],
        ]
      : [["Status", "not connected"]];
    $("#engineKv").replaceChildren(...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]));

    const r = this.last;
    if (!r) return;
    const t = r.timing || {};
    $("#timingKv").replaceChildren(
      ...[
        ["Frame", `#${r.seq}${r.image ? ` · ${r.image.width}×${r.image.height}` : " · text only"}`],
        ["Input tokens", String(r.usage?.input_tokens ?? "–")],
        ["Waited", `${ms(t.wait_ms)} ms before the model was free`],
        ["Preprocess", `${ms(t.prep_ms)} ms`],
        ["Model", `${ms(t.model_ms)} ms`],
        ["Server total", `${ms(t.server_ms)} ms`],
        ["Frames skipped", `${r.dropped ?? 0} replaced by newer ones`],
      ].flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]),
    );
    $("#lastJson").textContent = JSON.stringify({ model: r.model, answers: r.answers, usage: r.usage }, null, 2);
  }

  body() {
    const { questions, state, hasImage } = this.getRequest();
    const body = { model: "clef-flash", state, questions };
    if (hasImage) body.images = [IMAGE_PLACEHOLDER];
    return body;
  }

  snippet(kind) {
    const body = this.body();
    if (kind === "local") {
      return `curl ${location.origin}/v1/systemone \\\n  -H 'Content-Type: application/json' \\\n  -d ${shellQuote(JSON.stringify(body))}`;
    }
    if (kind === "workers") {
      return [
        "curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/clef-flash \\",
        '  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \\',
        `  -d ${shellQuote(JSON.stringify(body))}`,
      ].join("\n");
    }
    const { images, ...rest } = body;
    return [
      "import base64, json, urllib.request",
      "",
      `body = json.loads(${JSON.stringify(JSON.stringify(rest))})`,
      ...(images
        ? ['with open("frame.jpg", "rb") as f:', '    body["images"] = ["data:image/jpeg;base64," + base64.b64encode(f.read()).decode()]']
        : []),
      "request = urllib.request.Request(",
      `    "${location.origin}/v1/systemone",`,
      '    data=json.dumps(body).encode(),',
      '    headers={"Content-Type": "application/json"},',
      ")",
      "with urllib.request.urlopen(request) as response:",
      "    print(json.dumps(json.load(response)[\"answers\"], indent=2))",
    ].join("\n");
  }
}
