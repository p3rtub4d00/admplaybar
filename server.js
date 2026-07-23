import express from "express";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "crypto";
import { promisify } from "util";

dotenv.config();
const scrypt = promisify(scryptCallback);

// --- Conexão com o Banco de Dados do PlayBar (Mestre) ---
console.log('[PlayBar Master] Conectando ao MongoDB Mestre...');
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Conectado ao MongoDB do PlayBar com sucesso!'))
  .catch((err) => console.error('❌ Erro ao conectar ao MongoDB Mestre:', err));

// --- Schemas do PlayBar Master ---

// 1. Cadastro de Clientes (Bares/Estabelecimentos)
const ClientSchema = new mongoose.Schema({
  clientId: { type: String, unique: true, required: true }, // ex: "bar_do_ze"
  clientName: { type: String, required: true },               // ex: "Bar do Zé"
  model: { type: String, enum: ['aluguel', 'porcentagem'], default: 'aluguel' },
  monthlyFee: { type: Number, default: 150.00 },             // Valor do aluguel mensal
  percentageRate: { type: Number, default: 20 },             // % se for modelo por porcentagem
  expiresAt: { type: Date, required: true },                 // Data de vencimento da mensalidade
  isActive: { type: Boolean, default: true },                // True = Liberado, False = Bloqueado
  lastRevenueReported: { type: Number, default: 0.0 },       // Último faturamento reportado pelo bar
  createdAt: { type: Date, default: Date.now }
});
const ClientModel = mongoose.model('PlayBarClient', ClientSchema);

// 2. Configurações do Admin do PlayBar (Você)
const MasterConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'master_config', unique: true },
  adminPasswordHash: String
});
const MasterConfigModel = mongoose.model('PlayBarMasterConfig', MasterConfigSchema);

// --- Inicialização ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// Helpers de Senha Mestre
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash) return password === (process.env.MASTER_PASS || 'adminplaybar');
  const [salt, savedKey] = storedHash.split(':');
  if (!salt || !savedKey) return false;
  const derivedKey = await scrypt(password, salt, 64);
  const savedKeyBuffer = Buffer.from(savedKey, 'hex');
  return savedKeyBuffer.length === derivedKey.length && timingSafeEqual(savedKeyBuffer, derivedKey);
}

// --- ROTAS DA API (Para os sistemas dos clientes conversarem com o PlayBar) ---

// 1. Rota que o sistema do bar consulta para saber se está liberado ou bloqueado
app.get("/api/check-license", async (req, res) => {
  try {
    const { client_id } = req.query;
    if (!client_id) return res.status(400).json({ ok: false, error: "client_id obrigatório" });

    const client = await ClientModel.findOne({ clientId: client_id });
    if (!client) {
      return res.status(404).json({ ok: false, active: false, error: "Cliente não cadastrado no PlayBar." });
    }

    // Verifica se a data de vencimento passou
    const now = new Date();
    const isExpired = client.expiresAt < now;

    if (isExpired && client.isActive) {
      client.isActive = false; // Bloqueia automaticamente se venceu
      await client.save();
    }

    res.json({
      ok: true,
      active: client.isActive && !isExpired,
      clientName: client.clientName,
      model: client.model,
      expiresAt: client.expiresAt
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Erro interno ao validar licença." });
  }
});

// 2. Rota para o bar enviar o relatório de faturamento (usado no modelo de %)
app.post("/api/report-revenue", async (req, res) => {
  try {
    const { client_id, dailyRevenue } = req.body;
    if (!client_id) return res.status(400).json({ ok: false, error: "client_id obrigatório" });

    const client = await ClientModel.findOneAndUpdate(
      { clientId: client_id },
      { $set: { lastRevenueReported: Number(dailyRevenue) || 0 } },
      { new: true }
    );

    if (!client) return res.status(404).json({ ok: false, error: "Cliente não encontrado" });

    res.json({ ok: true, message: "Faturamento atualizado com sucesso no PlayBar." });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Erro ao atualizar faturamento." });
  }
});

// --- ROTAS DO PAINEL ADMIN DO PLAYBAR (Gerenciamento de Clientes) ---

app.get("/api/admin/clients", async (req, res) => {
  try {
    const clients = await ClientModel.find({}).sort({ createdAt: -1 }).lean();
    
    // Calcula quanto você tem para receber de cada um baseado no modelo
    const formatted = clients.map(c => {
      let comissaoOuAluguel = 0;
      if (c.model === 'aluguel') {
        comissaoOuAluguel = c.monthlyFee;
      } else {
        comissaoOuAluguel = (c.lastRevenueReported * c.percentageRate) / 100;
      }
      return { ...c, valorCalculado: comissaoOuAluguel };
    });

    res.json({ ok: true, clients: formatted });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Erro ao listar clientes" });
  }
});

app.post("/api/admin/clients", async (req, res) => {
  try {
    const { clientId, clientName, model, monthlyFee, percentageRate, expiresAt } = req.body;
    if (!clientId || !clientName || !expiresAt) {
      return res.status(400).json({ ok: false, error: "Preencha os campos obrigatórios." });
    }

    const newClient = await ClientModel.create({
      clientId: clientId.toLowerCase().trim().replace(/\s+/g, '_'),
      clientName,
      model: model || 'aluguel',
      monthlyFee: Number(monthlyFee) || 150,
      percentageRate: Number(percentageRate) || 20,
      expiresAt: new Date(expiresAt),
      isActive: true
    });

    res.json({ ok: true, client: newClient });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Erro ao cadastrar cliente (ID já pode existir)." });
  }
});

// Bloquear ou Desbloquear Cliente manualmente
app.post("/api/admin/clients/:id/toggle", async (req, res) => {
  try {
    const client = await ClientModel.findById(req.params.id);
    if (!client) return res.status(404).json({ ok: false, error: "Cliente não encontrado" });

    client.isActive = !client.isActive;
    await client.save();

    res.json({ ok: true, isActive: client.isActive });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Erro ao alterar status do cliente." });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 PlayBar Master Panel rodando na porta ${PORT}`);
});
