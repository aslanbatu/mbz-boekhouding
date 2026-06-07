const express = require("express");
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.static("public"));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const files = {
    facturen: path.join(DATA_DIR, "facturen.json"),
    klanten: path.join(DATA_DIR, "klanten.json"),
    leveranciers: path.join(DATA_DIR, "leveranciers.json"),
    instellingen: path.join(DATA_DIR, "instellingen.json")
};

for (const file of Object.values(files)) {
    if (!fs.existsSync(file) || fs.lstatSync(file).isDirectory()) {
        fs.writeFileSync(file, "[]", "utf8");
    }
}

function readJson(file) {
    try {
        const txt = fs.readFileSync(file, "utf8").trim();
        return txt ? JSON.parse(txt) : [];
    } catch {
        fs.writeFileSync(file, "[]", "utf8");
        return [];
    }
}

function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const cleanName = file.originalname.replace(/[^\w.\-() ]/g, "_");
        cb(null, Date.now() + "-" + cleanName);
    }
});

const upload = multer({ storage });

function cleanText(text) {
    return text
        .replace(/\r/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function parseBelgianNumber(value) {
    if (!value) return 0;

    let v = String(value)
        .replace(/€/g, "")
        .replace(/\s/g, "")
        .trim();

    if (v.includes(",") && v.includes(".")) {
        v = v.replace(/\./g, "").replace(",", ".");
    } else if (v.includes(",")) {
        v = v.replace(",", ".");
    }

    const n = Number(v);
    return isNaN(n) ? 0 : n;
}

function findFirst(text, patterns) {
    for (const regex of patterns) {
        const match = text.match(regex);
        if (match && match[1]) return match[1].trim();
    }
    return "";
}

function findAmount(text, labels) {
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
        const lower = line.toLowerCase();

        if (labels.some(label => lower.includes(label))) {
            const amounts = line.match(/-?\s*€?\s*[0-9]{1,3}(?:[.\s]?[0-9]{3})*(?:,[0-9]{2})|-?\s*€?\s*[0-9]+(?:[.,][0-9]{2})/g);
            if (amounts && amounts.length) {
                return parseBelgianNumber(amounts[amounts.length - 1]);
            }
        }
    }

    return 0;
}

function normalizeDate(dateText) {
    if (!dateText) return "";

    let d = dateText.trim();

    let m = d.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) {
        return `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}-${m[3]}`;
    }

    m = d.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) {
        return `${m[3].padStart(2, "0")}-${m[2].padStart(2, "0")}-${m[1]}`;
    }

    return d;
}

function getQuarter(dateText) {
    const m = dateText.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m) return "Q" + (Math.floor(new Date().getMonth() / 3) + 1);

    const month = Number(m[2]);

    if (month <= 3) return "Q1";
    if (month <= 6) return "Q2";
    if (month <= 9) return "Q3";
    return "Q4";
}

function getYear(dateText) {
    const m = dateText.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    return m ? m[3] : String(new Date().getFullYear());
}

function detectBtwRegeling(text) {
    const lower = text.toLowerCase();

    if (
        lower.includes("verlegging van heffing") ||
        lower.includes("medecontractant") ||
        lower.includes("medecontractor") ||
        lower.includes("btw verlegd") ||
        lower.includes("btw-verlegd") ||
        lower.includes("heffing")
    ) {
        return {
            naam: "Medecontractant / BTW verlegd",
            notitie: "Tekst over verlegging/heffing gevonden. Waarschijnlijk medecontractant / BTW verlegd."
        };
    }

    if (
        lower.includes("intracommunautair") ||
        lower.includes("intracom") ||
        lower.includes("reverse charge")
    ) {
        return {
            naam: "Intracommunautaire regeling / Reverse charge",
            notitie: "Intracommunautaire of reverse charge tekst gevonden."
        };
    }

    if (
        lower.includes("vrijgesteld van btw") ||
        lower.includes("vrijstelling") ||
        lower.includes("exempt")
    ) {
        return {
            naam: "Vrijstelling van BTW",
            notitie: "Vrijstelling van BTW gevonden."
        };
    }

    return {
        naam: "Normale BTW-regeling",
        notitie: "Geen bijzondere BTW-regeling gevonden."
    };
}

function detectType(text, filename, manualType) {
    const source = `${text} ${filename}`.toLowerCase();

    if (manualType === "income" || manualType === "inkomst") return "inkomst";
    if (manualType === "expense" || manualType === "uitgave") return "uitgave";

    if (
        source.includes("uitgave") ||
        source.includes("aankoop") ||
        source.includes("kosten") ||
        source.includes("leverancier") ||
        source.includes("supplier")
    ) {
        return "uitgave";
    }

    if (
        source.includes("inkomst") ||
        source.includes("verkoop") ||
        source.includes("klant") ||
        source.includes("factuur f")
    ) {
        return "inkomst";
    }

    if (source.includes("mbz group bv")) return "inkomst";

    return "inkomst";
}

function analyseFactuur(text, filename, manualType) {
    const originalText = text || "";
    const clean = cleanText(originalText);

    const factuurnummer = findFirst(clean, [
        /FACTUUR\s+([A-Z0-9\-/.]+)/i,
        /Factuurnummer\s*[:#]?\s*([A-Z0-9\-/.]+)/i,
        /Factuur\s*nr\.?\s*[:#]?\s*([A-Z0-9\-/.]+)/i,
        /Invoice\s*(?:no|number|nr)?\.?\s*[:#]?\s*([A-Z0-9\-/.]+)/i
    ]);

    const datumRaw = findFirst(clean, [
        /Datum\s*[:#]?\s*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/i,
        /Factuurdatum\s*[:#]?\s*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/i,
        /Invoice date\s*[:#]?\s*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/i,
        /([0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2})/
    ]);

    const datum = normalizeDate(datumRaw);

    const btwNummer = findFirst(clean, [
        /Btw-nummer klant\s*[:#]?\s*(BE[\s.]*[0-9\s.]{10,})/i,
        /BTW nummer klant\s*[:#]?\s*(BE[\s.]*[0-9\s.]{10,})/i,
        /BTW-nummer\s*[:#]?\s*(BE[\s.]*[0-9\s.]{10,})/i,
        /(BE[\s.]*[0-9\s.]{10,})/i
    ]).replace(/[\s.]/g, "");

    let netto = findAmount(clean, [
        "totaal excl",
        "totaal exclusief",
        "excl. btw",
        "excl btw",
        "netto",
        "subtotal",
        "subtotaal",
        "bedrag excl"
    ]);

    let btw = findAmount(clean, [
        "totaal btw",
        "btw bedrag",
        "btw:",
        "vat amount",
        "tva"
    ]);

    let bruto = findAmount(clean, [
        "totaal te betalen",
        "te betalen",
        "totaal incl",
        "totaal inclusief",
        "incl. btw",
        "incl btw",
        "bruto",
        "total due",
        "grand total"
    ]);

    const btwInfo = detectBtwRegeling(clean);

    if (!bruto && netto && btw) bruto = netto + btw;
    if (!netto && bruto && btw) netto = bruto - btw;
    if (!btw && netto && bruto) btw = Math.max(0, bruto - netto);

    if (btwInfo.naam.includes("Medecontractant") && netto && !bruto) {
        bruto = netto;
        btw = 0;
    }

    if (!bruto && netto) bruto = netto;

    const type = detectType(clean, filename, manualType);
    const jaar = datum ? getYear(datum) : String(new Date().getFullYear());
    const kwartaal = datum ? getQuarter(datum) : "Q" + (Math.floor(new Date().getMonth() / 3) + 1);

    return {
        id: Date.now(),
        bestand: filename,
        type,
        factuurnummer: factuurnummer || filename,
        datum,
        jaar,
        kwartaal,
        btwNummer,
        netto,
        btw,
        bruto,
        btwRegeling: btwInfo.naam,
        notitie: btwInfo.notitie,
        volledigeTekst: clean
    };
}

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/upload-factuur", upload.single("factuur"), async (req, res) => {
    try {
        if (!req.file) {
            throw new Error("Geen bestand ontvangen.");
        }

        const filePath = req.file.path;

        if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isDirectory()) {
            throw new Error("Bestand niet correct geüpload.");
        }

        const ext = path.extname(req.file.originalname).toLowerCase();

        if (ext !== ".pdf") {
            throw new Error("Voorlopig worden alleen PDF-bestanden automatisch gelezen.");
        }

        const dataBuffer = fs.readFileSync(filePath);

        const parser = new PDFParse({ data: dataBuffer });
        const pdfData = await parser.getText();

        const analyse = analyseFactuur(
            pdfData.text,
            req.file.filename,
            req.body.manualType
        );

        const facturen = readJson(files.facturen);
        facturen.push(analyse);
        writeJson(files.facturen, facturen);

        if (analyse.type === "inkomst") {
            const klanten = readJson(files.klanten);
            const bestaat = klanten.find(k => k.btwNummer === analyse.btwNummer);

            if (!bestaat && analyse.btwNummer) {
                klanten.push({
                    id: Date.now(),
                    bedrijfsnaam: "Onbekende klant",
                    btwNummer: analyse.btwNummer,
                    adres: "",
                    telefoon: "",
                    contactpersoon: ""
                });

                writeJson(files.klanten, klanten);
            }
        }

        if (analyse.type === "uitgave") {
            const leveranciers = readJson(files.leveranciers);
            const bestaat = leveranciers.find(l => l.btwNummer === analyse.btwNummer);

            if (!bestaat && analyse.btwNummer) {
                leveranciers.push({
                    id: Date.now(),
                    bedrijfsnaam: "Onbekende leverancier",
                    btwNummer: analyse.btwNummer,
                    adres: "",
                    telefoon: "",
                    contactpersoon: ""
                });

                writeJson(files.leveranciers, leveranciers);
            }
        }

        res.json({
            success: true,
            analyse
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get("/api/facturen", (req, res) => {
    res.json(readJson(files.facturen));
});

app.delete("/api/facturen/:id", (req, res) => {
    const id = Number(req.params.id);
    const facturen = readJson(files.facturen).filter(f => f.id !== id);

    writeJson(files.facturen, facturen);

    res.json({ success: true });
});

app.get("/api/klanten", (req, res) => {
    res.json(readJson(files.klanten));
});

app.post("/api/klanten", (req, res) => {
    const klanten = readJson(files.klanten);

    const bestaat = klanten.find(k => k.btwNummer === req.body.btwNummer);

    if (!bestaat) {
        klanten.push({
            id: Date.now(),
            bedrijfsnaam: req.body.bedrijfsnaam,
            btwNummer: req.body.btwNummer,
            adres: req.body.adres,
            telefoon: req.body.telefoon,
            contactpersoon: req.body.contactpersoon
        });

        writeJson(files.klanten, klanten);
    }

    res.json({ success: true });
});

app.get("/api/leveranciers", (req, res) => {
    res.json(readJson(files.leveranciers));
});

app.post("/api/leveranciers", (req, res) => {
    const leveranciers = readJson(files.leveranciers);

    const bestaat = leveranciers.find(l => l.btwNummer === req.body.btwNummer);

    if (!bestaat) {
        leveranciers.push({
            id: Date.now(),
            bedrijfsnaam: req.body.bedrijfsnaam,
            btwNummer: req.body.btwNummer,
            adres: req.body.adres,
            telefoon: req.body.telefoon,
            contactpersoon: req.body.contactpersoon
        });

        writeJson(files.leveranciers, leveranciers);
    }

    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log("Server draait op http://localhost:" + PORT);
});