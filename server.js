const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('.'));

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracking-data.json');

// Ensure data dir & file exist
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2), 'utf8');

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeData(d) {
  // atomic write: write to temp then rename
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function findShipment(tracking) {
  if (!tracking) return null;
  const data = readData();
  return data[tracking] || Object.values(data).find(s => s.trackingNumber === tracking) || null;
}

// --- Receipt generation helpers ---
function generatePdfBuffer(shipment) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(20).text('AGE-MATE Global Logistics', { align: 'left' });
    doc.moveDown();
    doc.fontSize(12).text(`Tracking Receipt: ${shipment.trackingNumber}`);
    doc.text(`Status: ${shipment.status}`);
    doc.text(`Origin: ${shipment.origin}  →  Destination: ${shipment.destination}`);
    doc.moveDown();
    doc.fontSize(10).text('Company: AGE-MATE Global Logistics');
    doc.text('Address: 123 Logistics Way, Shanghai / 45 Lagos Ave, Lagos');
    doc.text('Contact: contact@agemateglobal.com | +1-555-0100');
    doc.moveDown();

    const labelWidth = 140;
    const row = (label, value) => {
      doc.font('Helvetica-Bold').text(label, { continued: true, width: labelWidth });
      doc.font('Helvetica').text(String(value || ''));
    };

    row('User Name', shipment.userName);
    row('Loading Date', shipment.loadingDate);
    row('Phone Number', shipment.phone);
    row('Tracking Number', shipment.trackingNumber);
    row('Goods Description', shipment.goodsDescription);
    row('Quantity', shipment.quantity);
    row('CBM', shipment.cbm);
    row('Rate per CBM', shipment.ratePerCbm);
    row('Total Amount', shipment.totalAmount);
    row('Container Number', shipment.containerNumber);

    doc.end();
  });
}

// --- API: simple tracking (used by frontend) ---
app.post('/api/track', (req, res) => {
  const tracking = (req.body && req.body.tracking) || '';
  if (!tracking) return res.status(400).json({ message: 'tracking required' });
  const shipment = findShipment(tracking);
  if (!shipment) return res.status(404).json({ message: 'Tracking number not found' });
  res.json(shipment);
});

// --- API: upsert single shipment ---
app.post('/api/shipments', (req, res) => {
  const s = req.body;
  if (!s || !s.trackingNumber) return res.status(400).json({ message: 'trackingNumber required' });
  const data = readData();
  data[s.trackingNumber] = s;
  writeData(data);
  res.status(201).json({ ok: true, trackingNumber: s.trackingNumber });
});

// --- API: update existing shipment partially ---
app.put('/api/shipments/:tracking', (req, res) => {
  const t = req.params.tracking;
  const data = readData();
  if (!data[t]) return res.status(404).json({ message: 'not found' });
  data[t] = { ...data[t], ...req.body };
  writeData(data);
  res.json(data[t]);
});

// --- CSV import (bulk) ---
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/import-csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'file is required in form field "file"' });
  try {
    const text = req.file.buffer.toString('utf8');
    const records = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    const data = readData();
    const errors = [];
    let imported = 0;
    records.forEach((r, idx) => {
      const t = r.trackingNumber || r.tracking || r.id;
      if (!t) {
        errors.push({ row: idx + 1, error: 'missing trackingNumber' });
        return;
      }
      if (r.quantity) r.quantity = isNaN(Number(r.quantity)) ? r.quantity : Number(r.quantity);
      if (r.cbm) r.cbm = isNaN(Number(r.cbm)) ? r.cbm : Number(r.cbm);
      const existing = data[t] || {};
      data[t] = { ...existing, ...r, trackingNumber: t };
      imported++;
    });
    writeData(data);
    res.json({ ok: true, imported, errors });
  } catch (err) {
    res.status(400).json({ message: 'failed to parse csv', error: err.message });
  }
});

// --- Receipt endpoints (pdf + jpeg) ---
app.get('/api/receipt/:tracking/pdf', async (req, res) => {
  const tracking = req.params.tracking;
  const shipment = findShipment(tracking);
  if (!shipment) return res.status(404).send('Tracking number not found');
  try {
    const pdfBuffer = await generatePdfBuffer(shipment);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${shipment.trackingNumber}-receipt.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    res.status(500).send('Error generating PDF');
  }
});

app.get('/api/receipt/:tracking/jpeg', async (req, res) => {
  const tracking = req.params.tracking;
  const shipment = findShipment(tracking);
  if (!shipment) return res.status(404).send('Tracking number not found');
  try {
    const pdfBuffer = await generatePdfBuffer(shipment);
    const imgBuffer = await sharp(pdfBuffer, { density: 150 }).jpeg({ quality: 85 }).toBuffer();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${shipment.trackingNumber}-receipt.jpg"`);
    res.send(imgBuffer);
  } catch (e) {
    res.status(500).send('Error generating JPEG');
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));