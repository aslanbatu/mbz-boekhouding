
const express = require("express");
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const { createWorker } = require("tesseract.js");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.static("public"));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.json({ limit: "30mb" }));

const DB = {
  invoices: path.join(DATA_DIR, "invoices.json"),
  clients: path.join(DATA_DIR, "clients.json"),
  suppliers: path.join(DATA_DIR, "suppliers.json"),
  documents: path.join(DATA_DIR, "documents.json"),
  audit: path.join(DATA_DIR, "audit.json")
};

for (const file of Object.values(DB)) {
  if (!fs.existsSync(file) || fs.lstatSync(file).isDirectory()) fs.writeFileSync(file, "[]", "utf8");
}

const read = file => {
  try { const t = fs.readFileSync(file, "utf8").trim(); return t ? JSON.parse(t) : []; }
  catch { fs.writeFileSync(file, "[]", "utf8"); return []; }
};
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
const audit = (action, detail = {}) => {
  const rows = read(DB.audit);
  rows.unshift({ id: Date.now(), at: new Date().toISOString(), action, detail });
  write(DB.audit, rows.slice(0, 800));
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => cb(null, Date.now() + "-" + String(file.originalname || "bestand").replace(/[^\w.\-() ]/g, "_"))
  }),
  limits: { fileSize: 35 * 1024 * 1024 }
});

function normText(s) {
  return String(s || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function parseMoney(v) {
  if (!v) return 0;
  let x = String(v).replace(/€/g, "").replace(/\s/g, "").trim();
  if (x.includes(",") && x.includes(".")) x = x.replace(/\./g, "").replace(",", ".");
  else if (x.includes(",")) x = x.replace(",", ".");
  const n = Number(x.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
function moneyFromLine(line) {
  const matches = String(line).match(/-?\s*€?\s*[0-9]{1,3}(?:[.\s]?[0-9]{3})*(?:,[0-9]{2})|-?\s*€?\s*[0-9]+(?:[.,][0-9]{2})/g) || [];
  return matches.map(parseMoney).filter(n => n >= 0);
}
function first(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}
function allVat(text) {
  const arr = text.match(/BE[\s.]?0?[0-9][\s.]?[0-9]{3}[\s.]?[0-9]{3}[\s.]?[0-9]{3}/gi) || [];
  return [...new Set(arr.map(v => v.toUpperCase().replace(/[\s.]/g, "")))];
}
function amountByLabels(text, labels) {
  for (const line of text.split("\n").map(x => x.trim()).filter(Boolean)) {
    const l = line.toLowerCase();
    if (labels.some(x => l.includes(x))) {
      const nums = moneyFromLine(line);
      if (nums.length) return nums[nums.length - 1];
    }
  }
  return 0;
}
function largestMoney(text) {
  const nums = [];
  text.split("\n").forEach(line => nums.push(...moneyFromLine(line)));
  return nums.length ? Math.max(...nums) : 0;
}
function normDate(s) {
  if (!s) return "";
  let m = String(s).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}-${m[3]}`;
  m = String(s).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[3].padStart(2,"0")}-${m[2].padStart(2,"0")}-${m[1]}`;
  return "";
}
function year(date) {
  const m = String(date).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? m[3] : String(new Date().getFullYear());
}
function quarter(date) {
  const m = String(date).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  const month = m ? Number(m[2]) : new Date().getMonth() + 1;
  return month <= 3 ? "Q1" : month <= 6 ? "Q2" : month <= 9 ? "Q3" : "Q4";
}
function regime(text) {
  const l = text.toLowerCase();
  if (["verlegging van heffing","medecontractant","medecontractor","btw verlegd","btw-verlegd","heffing"].some(x => l.includes(x))) {
    return { name: "Medecontractant / BTW verlegd", note: "Medecontractant/verlegging/heffing gevonden. BTW is 0 en wordt verlegd." };
  }
  if (["intracom", "intracommunautair", "reverse charge"].some(x => l.includes(x))) {
    return { name: "Intracommunautaire regeling / Reverse charge", note: "Intracommunautaire of reverse-charge tekst gevonden." };
  }
  if (["vrijstelling", "vrijgesteld van btw", "exempt"].some(x => l.includes(x))) {
    return { name: "Vrijstelling van BTW", note: "Vrijstelling van BTW gevonden." };
  }
  return { name: "Normale BTW-regeling", note: "Geen bijzondere BTW-regeling gevonden." };
}
function inferType(text, filename, manual) {
  if (manual === "income" || manual === "inkomst") return "income";
  if (manual === "expense" || manual === "uitgave") return "expense";
  const s = `${text} ${filename}`.toLowerCase();
  if (["restaurant","kassaticket","bon","aankoop","kosten","leverancier","supplier","receipt","uitgave"].some(x => s.includes(x))) return "expense";
  if (s.includes("mbz group bv")) return "income";
  return "income";
}
function getPartyBlock(lines, ownVat) {
  const vatIndex = lines.findIndex(l => l.replace(/[\s.]/g,"").toUpperCase().includes(ownVat));
  if (vatIndex < 0) return { own: {}, other: {} };

  const ownStart = Math.max(0, vatIndex - 3);
  const ownBlock = lines.slice(ownStart, Math.min(lines.length, vatIndex + 5));

  let otherStart = vatIndex + 1;
  for (let i = vatIndex + 1; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (l.includes("rpr") || l.includes("gsm") || l.includes("iban") || l.includes("@")) continue;
    if (/(bv|nv|vzw|telecom|restaurant|group|services|solutions|company|sprl|srl|sa)/i.test(lines[i])) {
      otherStart = i;
      break;
    }
  }

  let otherEnd = lines.length;
  for (let i = otherStart; i < lines.length; i++) {
    if (/factuur|invoice|datum|omschrijving|totaal/i.test(lines[i])) {
      otherEnd = i;
      break;
    }
  }
  const otherBlock = lines.slice(otherStart, otherEnd);

  function parseBlock(block) {
    const company = block.find(l => /(bv|nv|vzw|telecom|restaurant|group|services|solutions|company|sprl|srl|sa)/i.test(l)) || block[0] || "";
    const addressLine = block.find(l => /\d/.test(l) && !/BE\d|gsm|iban|factuur|datum/i.test(l)) || "";
    const zipCity = block.find(l => /\b\d{4}\b/.test(l)) || "";
    const vat = (block.join(" ").match(/BE[\s.]?0?[0-9][\s.]?[0-9]{3}[\s.]?[0-9]{3}[\s.]?[0-9]{3}/i) || [""])[0].toUpperCase().replace(/[\s.]/g, "");
    const email = (block.join(" ").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [""])[0];
    const phone = (block.join(" ").match(/(?:GSM|TEL|Telefoon)?[:\s]*(\+?\d[\d\s/.-]{7,})/i) || ["",""])[1].trim();
    return { company, address: [addressLine, zipCity].filter(Boolean).join(", "), vatNumber: vat, email, phone };
  }

  return { own: parseBlock(ownBlock), other: parseBlock(otherBlock) };
}
async function readText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === ".pdf") {
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    const data = await parser.getText();
    return data.text || "";
  }
  if ([".jpg",".jpeg",".png",".webp",".bmp"].includes(ext)) {
    const worker = await createWorker("eng");
    const result = await worker.recognize(filePath);
    await worker.terminate();
    return result.data.text || "";
  }
  return "";
}
function analyze(raw, filename, manual) {
  const text = normText(raw);
  const lines = text.split("\n").map(x => x.trim()).filter(Boolean);
  const type = inferType(text, filename, manual);
  const vatInfo = regime(text);
  const ownVat = "BE1007771305";
  const parties = getPartyBlock(lines, ownVat);

  const invoiceNo = first(text, [
    /FACTUUR\s+([A-Z0-9\-/.]+)/i,
    /Factuurnummer\s*[:#]?\s*([A-Z0-9\-/.]+)/i,
    /Factuur\s*nr\.?\s*[:#]?\s*([A-Z0-9\-/.]+)/i,
    /Invoice\s*(?:no|number|nr)?\.?\s*[:#]?\s*([A-Z0-9\-/.]+)/i,
    /Ticket\s*[:#]?\s*([A-Z0-9\-/.]+)/i,
    /Bon\s*[:#]?\s*([A-Z0-9\-/.]+)/i
  ]) || filename;

  const date = normDate(first(text, [
    /Datum\s*[:#]?\s*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/i,
    /Factuurdatum\s*[:#]?\s*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/i,
    /Date\s*[:#]?\s*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/i,
    /([0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2})/,
    /([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/
  ]));
  const dueDate = normDate(first(text, [
    /Vervaldatum\s*[:#]?\s*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/i,
    /Due date\s*[:#]?\s*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/i
  ]));

  const vats = allVat(text);
  let vatNumber = parties.other.vatNumber || vats.find(v => v !== ownVat) || "";
  let company = parties.other.company || (type === "income" ? "Onbekende klant" : "Onbekende leverancier");
  let address = parties.other.address || "";

  let net = amountByLabels(text, ["totaal excl","exclusief","excl. btw","excl btw","netto","subtotal","subtotaal","bedrag excl"]);
  let vat = amountByLabels(text, ["totaal btw","btw bedrag","btw:","vat amount","vat","tva"]);
  let gross = amountByLabels(text, ["totaal te betalen","te betalen","totaal incl","inclusief","incl. btw","incl btw","bruto","total due","grand total","totaal","bancontact","betaald"]);
  if (!gross) gross = largestMoney(text);
  if (!gross && net && vat) gross = net + vat;
  if (!net && gross && vat) net = Math.max(0, gross - vat);
  if (!vat && net && gross) vat = Math.max(0, gross - net);
  if (vatInfo.name.includes("Medecontractant")) { vat = 0; if (!net && gross) net = gross; if (!gross && net) gross = net; }
  if (!net && gross) net = gross;
  if (!gross && net) gross = net;

  const y = date ? year(date) : String(new Date().getFullYear());
  const q = date ? quarter(date) : "Q" + (Math.floor(new Date().getMonth()/3)+1);
  const confidence = [invoiceNo !== filename, !!date, !!vatNumber, !!company, gross > 0, text.length > 20].filter(Boolean).length / 6;

  return {
    id: Date.now(), file: filename, fileUrl: "/uploads/" + filename, type,
    invoiceNo, date, dueDate, year: y, quarter: q,
    company, vatNumber, address, phone: parties.other.phone || "", email: parties.other.email || "", contact: "",
    ownCompany: parties.own.company || "MBZ Group BV", ownVat,
    ownAddress: parties.own.address || "Veldekensstraat 23, 9240 Zele",
    net, vat, gross, vatRegime: vatInfo.name, note: vatInfo.note,
    confidence: Math.round(confidence * 100), status: confidence < 0.65 ? "Controle nodig" : "OK",
    warning: text.length < 20 ? "Geen tekst gevonden. Waarschijnlijk scan/foto met lage kwaliteit." : "",
    rawText: text
  };
}
function upsertRelation(kind, inv) {
  if (!inv.vatNumber && !inv.company) return;
  const file = kind === "client" ? DB.clients : DB.suppliers;
  const list = read(file);
  const found = list.find(x => (inv.vatNumber && String(x.vatNumber).toUpperCase() === String(inv.vatNumber).toUpperCase()) || (!inv.vatNumber && x.company === inv.company));
  if (!found) {
    list.push({ id: Date.now(), company: inv.company, vatNumber: inv.vatNumber, address: inv.address, phone: inv.phone, email: inv.email, contact: inv.contact, createdFromInvoice: inv.invoiceNo });
    write(file, list);
  }
}

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

async function uploadInvoice(req, res) {
  try {
    if (!req.file) throw new Error("Geen bestand ontvangen.");
    const text = await readText(req.file.path, req.file.originalname);
    const inv = analyze(text, req.file.filename, req.body.manualType);
    const list = read(DB.invoices); list.push(inv); write(DB.invoices, list);
    upsertRelation(inv.type === "income" ? "client" : "supplier", inv);
    audit("invoice.upload", { id: inv.id, invoiceNo: inv.invoiceNo, company: inv.company });
    res.json({ success: true, invoice: inv, analyse: inv });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
}
app.post("/api/upload-invoice", upload.single("invoice"), uploadInvoice);
app.post("/api/upload-factuur", upload.single("factuur"), uploadInvoice);

app.post("/api/upload-document", upload.single("document"), (req,res)=>{
  try {
    if (!req.file) throw new Error("Geen document ontvangen.");
    const docs = read(DB.documents);
    const doc = { id: Date.now(), name: req.file.originalname, file: req.file.filename, fileUrl: "/uploads/" + req.file.filename, type: req.body.type || "Document", date: new Date().toLocaleDateString("nl-BE") };
    docs.push(doc); write(DB.documents, docs); res.json({ success:true, document:doc });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get("/api/invoices", (_,res)=>res.json(read(DB.invoices)));
app.get("/api/clients", (_,res)=>res.json(read(DB.clients)));
app.get("/api/suppliers", (_,res)=>res.json(read(DB.suppliers)));
app.get("/api/documents", (_,res)=>res.json(read(DB.documents)));
app.get("/api/export", (_,res)=>res.json({ invoices:read(DB.invoices), clients:read(DB.clients), suppliers:read(DB.suppliers), documents:read(DB.documents) }));

app.post("/api/clients", (req,res)=>{ const l=read(DB.clients); l.push({id:Date.now(),...req.body}); write(DB.clients,l); res.json({success:true}); });
app.post("/api/suppliers", (req,res)=>{ const l=read(DB.suppliers); l.push({id:Date.now(),...req.body}); write(DB.suppliers,l); res.json({success:true}); });

for (const [route,file] of [["invoices",DB.invoices],["clients",DB.clients],["suppliers",DB.suppliers],["documents",DB.documents]]) {
  app.put(`/api/${route}/:id`, (req,res)=>{
    const id = Number(req.params.id);
    const list = read(file).map(x => x.id === id ? { ...x, ...req.body, id } : x);
    write(file, list); audit(route+".edit",{id}); res.json({success:true});
  });
  app.delete(`/api/${route}/:id`, (req,res)=>{
    const id = Number(req.params.id);
    write(file, read(file).filter(x=>x.id!==id)); audit(route+".delete",{id}); res.json({success:true});
  });
}

app.listen(PORT, () => console.log("Server draait op http://localhost:" + PORT));
