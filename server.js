const express = require("express");
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.static("public"));
app.use(express.json());

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const files = {
    facturen: path.join(DATA_DIR, "facturen.json"),
    klanten: path.join(DATA_DIR, "klanten.json"),
    leveranciers: path.join(DATA_DIR, "leveranciers.json"),
    instellingen: path.join(DATA_DIR, "instellingen.json")
};

for (const file of Object.values(files)) {
    if (fs.existsSync(file) && fs.lstatSync(file).isDirectory()) {
        fs.rmSync(file, { recursive: true, force: true });
    }

    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, "[]", "utf8");
    }
}

function readJson(file) {
    if (!fs.existsSync(file) || fs.lstatSync(file).isDirectory()) {
        fs.writeFileSync(file, "[]", "utf8");
        return [];
    }

    const content = fs.readFileSync(file, "utf8").trim();

    if (!content) {
        fs.writeFileSync(file, "[]", "utf8");
        return [];
    }

    try {
        return JSON.parse(content);
    } catch {
        fs.writeFileSync(file, "[]", "utf8");
        return [];
    }
}

function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + "-" + file.originalname);
    }
});

const upload = multer({ storage });

function parseBelgianNumber(value) {
    if (!value) return 0;

    return Number(
        value
            .replace(/\s/g, "")
            .replace(/\./g, "")
            .replace(",", ".")
    );
}

function findMatch(text, regex) {
    const match = text.match(regex);
    return match ? match[1].trim() : "";
}

function getQuarter(dateText) {
    const parts = dateText.split("-");
    const month = Number(parts[1]);

    if (month <= 3) return "Q1";
    if (month <= 6) return "Q2";
    if (month <= 9) return "Q3";

    return "Q4";
}

function getYear(dateText) {
    const parts = dateText.split("-");
    return parts[2] || String(new Date().getFullYear());
}

function analyseFactuur(text, filename) {
    const lower = text.toLowerCase();

    const factuurnummer =
        findMatch(text, /FACTUUR\s+([A-Z0-9\-]+)/i) ||
        findMatch(text, /Factuurnummer[:\s]+([A-Z0-9\-]+)/i);

    const datum =
        findMatch(text, /Datum:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i) ||
        findMatch(text, /Factuurdatum[:\s]+([0-9]{2}-[0-9]{2}-[0-9]{4})/i);

    const btwNummer =
        findMatch(text, /Btw-nummer klant:\s*(BE[0-9]+)/i) ||
        findMatch(text, /(BE[0-9]{10})/i);

    const nettoText =
        findMatch(text, /Totaal excl\.:\s*€?\s*([0-9\s.,]+)/i) ||
        findMatch(text, /Netto[:\s]+€?\s*([0-9\s.,]+)/i);

    const brutoText =
        findMatch(text, /Totaal te betalen:\s*€?\s*([0-9\s.,]+)/i) ||
        findMatch(text, /Bruto[:\s]+€?\s*([0-9\s.,]+)/i);

    const netto = parseBelgianNumber(nettoText);
    const bruto = parseBelgianNumber(brutoText || nettoText);
    const btw = Math.max(0, bruto - netto);

    const medecontractor =
        lower.includes("verlegging van heffing") ||
        lower.includes("medecontractant") ||
        lower.includes("btw verlegd") ||
        lower.includes("heffing");

    const type = lower.includes("mbz group bv")
        ? "inkomst"
        : "uitgave";

    const jaar = datum ? getYear(datum) : String(new Date().getFullYear());
    const kwartaal = datum
        ? getQuarter(datum)
        : "Q" + (Math.floor(new Date().getMonth() / 3) + 1);

    return {
        id: Date.now(),
        bestand: filename,
        type,
        factuurnummer,
        datum,
        jaar,
        kwartaal,
        btwNummer,
        netto,
        btw,
        bruto,
        btwRegeling: medecontractor
            ? "Medecontractant / BTW verlegd"
            : "Normale BTW-regeling",
        notitie: medecontractor
            ? "Op deze factuur staat tekst over verlegging/heffing. Waarschijnlijk medecontractant."
            : "Geen bijzondere BTW-regeling gevonden.",
        volledigeTekst: text
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
            throw new Error("PDF bestand niet correct geüpload.");
        }

        const dataBuffer = fs.readFileSync(filePath);

        const parser = new PDFParse({ data: dataBuffer });
        const pdfData = await parser.getText();

        const analyse = analyseFactuur(pdfData.text, req.file.filename);

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

app.listen(3000, () => {
    console.log("Server draait op http://localhost:3000");
});