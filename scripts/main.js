// scripts/main.js
import { parseAny, parseBlockBest } from "./parser/index.js";
import { convertBlock } from "./convert/convert.js";
import { scanPdf } from "./scan/browser-scan.js";

const MODULE_ID = "draw-steel-4e-converter";

export class FourEConverterUI extends Application {
  constructor(options = {}) {
    super(options);
    this.blocks = [];
    this.onlyReview = false;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "four-e-converter",
      title: "Convert 4e Monsters",
      template: `modules/${MODULE_ID}/templates/converter-ui.html`,
      width: 880,
      height: 740,
      resizable: true,
      classes: ["draw-steel", "four-e-converter-window"]
    });
  }

  getData() {
    return { sourceBook: "Monster Manual" };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("#fec-parse").on("click", () => this._parse(html));
    html.find("#fec-import").on("click", () => this._import(html));
    html.find("#fec-file").on("change", async (ev) => {
      const file = ev.currentTarget.files?.[0];
      if (!file) return;
      if (/\.pdf$/i.test(file.name)) return this._scan(file, html);
      html.find("#fec-text").val(await file.text());
      this._parse(html);
    });
  }

  /** Step 1: find stat blocks in the pasted text and list them. */
  _parse(html) {
    const raw = html.find("#fec-text").val() ?? "";
    const preview = html.find("#fec-preview");
    const importButton = html.find("#fec-import");
    preview.empty();
    importButton.prop("disabled", true);

    if (!raw.trim()) {
      ui.notifications.warn("No text provided for conversion.");
      return;
    }

    this.skippedNote = "";
    this.blocks = parseAny(raw);
    this._list(html);
  }

  /** Scan a whole adventure PDF in the browser (text layer + OCR of each stat block). */
  async _scan(file, html) {
    const status = html.find("#fec-status");
    const preview = html.find("#fec-preview");
    const importButton = html.find("#fec-import");
    preview.empty();
    importButton.prop("disabled", true);
    html.find("#fec-file, #fec-parse").prop("disabled", true);
    this._cancel = false;
    html.find("#fec-cancel").show().off("click").on("click", () => { this._cancel = true; });
    try {
      const { blocks, skipped } = await scanPdf(file, {
        base: foundry.utils.getRoute(`modules/${MODULE_ID}`),
        shouldCancel: () => this._cancel,
        onProgress: (p) => status.text(p.message)
      });
      this.blocks = blocks;
      this.skippedNote = skipped.length ? `${skipped.length} trap${skipped.length === 1 ? "" : "s"}/hazard${skipped.length === 1 ? "" : "s"} skipped.` : "";
      status.text(blocks.length
        ? `Found ${blocks.length} monster${blocks.length === 1 ? "" : "s"}${skipped.length ? ` (${skipped.length} traps/hazards skipped)` : ""}${this._cancel ? " before cancelling" : ""}.`
        : "No stat blocks found in that PDF.");
      this._list(html);
    } catch (err) {
      console.error("4e Converter scan error:", err);
      status.text("The scan failed. See the console (F12) for details.");
      ui.notifications.error("Could not scan that PDF.");
    } finally {
      html.find("#fec-file, #fec-parse").prop("disabled", false);
      html.find("#fec-cancel").hide();
    }
  }

  /** List the parsed blocks with checkboxes, flagging the ones that need a look. */
  _list(html) {
    const preview = html.find("#fec-preview");
    const importButton = html.find("#fec-import");
    preview.empty();
    importButton.prop("disabled", true);
    if (!this.blocks.length) {
      preview.append(`<p>No 4e stat blocks found. Each block should start with a line like "Goblin Cutter Level 1 Minion" and include HP and AC lines.</p>`);
      return;
    }

    const esc = foundry.utils.escapeHTML;
    const standardAs = html.find("#fec-standard").val();
    const empty = (b) => !b.items?.length;
    const flagged = this.blocks.filter((b) => empty(b) || b.checks?.length).length;
    preview.append(
      `<p class="fec-summary">${this.blocks.length} monster${this.blocks.length === 1 ? "" : "s"} found` +
      (flagged ? `; <span class="fec-warn"><i class="fas fa-triangle-exclamation"></i> ${flagged} need review</span>. Hover the icon for the reasons, or use <b>Edit text</b> to fix the source and read it again.` : ".") +
      (this.skippedNote ? ` ${esc(this.skippedNote)}` : "") + `</p>` +
      (flagged ? `<label class="fec-filter"><input type="checkbox" id="fec-only-review" ${this.onlyReview ? "checked" : ""} /> Show only the ones that need review</label>` : "")
    );
    this.blocks.forEach((block, i) => {
      let line;
      try {
        const actor = convertBlock(block, { standardAs, rid: () => foundry.utils.randomID() });
        const m = actor.system.monster;
        line = `4e level ${block.level} ${block.organization}${block.role ? " " + block.role : ""} &rarr; level ${m.level} ${m.organization} ${m.role}`;
      } catch (err) {
        line = "could not be converted";
        block.checks = [...(block.checks ?? []), "conversion failed: " + err.message];
      }
      const notes = [...(block.checks ?? []).map((c) => "Check: " + c), ...(block.warnings ?? [])];
      const bad = empty(block) || (block.checks ?? []).length;
      const warn = notes.length ? ` <span class="fec-warn" title="${esc(notes.join("\n"))}"><i class="fas fa-triangle-exclamation"></i></span>` : "";
      const checked = empty(block) ? "" : "checked";
      preview.append(
        `<div class="fec-row${bad || !this.onlyReview ? "" : " fec-hidden"}" data-index="${i}"><label><input type="checkbox" class="fec-pick" data-index="${i}" ${checked} />` +
        `<span>${esc(block.name)}</span><span class="fec-meta">${line}</span>${warn}</label>` +
        (bad || block.raw ? ` <a class="fec-edit" data-index="${i}">Edit text</a>` : "") +
        `<div class="fec-editor" style="display:none"><textarea rows="8"></textarea><button type="button" class="fec-reparse">Read again</button></div></div>`
      );
    });
    preview.find("#fec-only-review").on("change", (ev) => {
      this.onlyReview = ev.currentTarget.checked;
      preview.find(".fec-row").each((_, el) => {
        const b = this.blocks[Number(el.dataset.index)];
        const isBad = !b.items?.length || b.checks?.length;
        $(el).toggleClass("fec-hidden", this.onlyReview && !isBad);
      });
    });
    preview.find(".fec-edit").on("click", (ev) => {
      const row = $(ev.currentTarget).closest(".fec-row");
      const ed = row.find(".fec-editor");
      const i = Number(row.data("index"));
      ed.find("textarea").val(this.blocks[i].raw ?? "");
      ed.toggle();
    });
    preview.find(".fec-reparse").on("click", (ev) => {
      const row = $(ev.currentTarget).closest(".fec-row");
      const i = Number(row.data("index"));
      const fixed = parseBlockBest(row.find("textarea").val() ?? "", { hint: { page: this.blocks[i].source?.page } });
      if (!fixed || fixed.skipped) { ui.notifications.warn("That text could not be read as a stat block."); return; }
      this.blocks[i] = fixed;
      this._list(html);
    });
    importButton.prop("disabled", false);
    html.find("#fec-input").prop("open", false);   // give the list the room
  }

  /** Step 2: convert and create the checked monsters. */
  async _import(html) {
    try {
      const sourceBook = html.find("#fec-book").val()?.trim() || "Monster Manual";
      const standardAs = html.find("#fec-standard").val();
      const folderName = html.find("#fec-folder").val()?.trim();
      const picked = html.find(".fec-pick:checked").map((_, el) => Number(el.dataset.index)).get();
      if (!picked.length) {
        ui.notifications.warn("No monsters selected.");
        return;
      }

      let folderId = null;
      if (folderName) {
        let folder = game.folders.find((f) => f.name === folderName && f.type === "Actor");
        if (!folder) folder = await Folder.create({ name: folderName, type: "Actor", color: "#4b4a44" });
        folderId = folder.id;
      }

      const created = [];
      for (const i of picked) {
        const data = convertBlock(this.blocks[i], { sourceBook, standardAs, rid: () => foundry.utils.randomID() });
        const actor = await Actor.create({ ...data, folder: folderId });
        created.push(actor.name);
      }

      ui.notifications.info(
        created.length === 1 ? `Converted: ${created[0]}` : `Converted ${created.length} monsters: ${created.join(", ")}`
      );
      this.close();
    } catch (err) {
      console.error("4e Converter Error:", err);
      ui.notifications.error("Failed to convert monster. Check console for details.");
    }
  }
}

Hooks.on("renderActorDirectory", (app, element) => {
  const html = $(element);
  const footer = html.find(".directory-footer");
  if (footer.find(".four-e-converter-button").length) return;

  const button = $(`<button class="four-e-converter-button">
    <i class="fas fa-dragon"></i> Convert 4e Monster
  </button>`);
  button.on("click", () => new FourEConverterUI().render(true));
  footer.append(button);
});
