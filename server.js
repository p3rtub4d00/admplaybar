import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('[PlayBar Master] Conectado ao MongoDB Mestre...'))
  .catch(err => console.error('Erro ao conectar ao MongoDB Mestre:', err));

// Schema do Cliente (Adicionado campo trustUnlockUntil)
const clientSchema = new mongoose.Schema({
    client_id: { type: String, required: true, unique: true },
    name: String,
    phone: String,
    model: String, 
    value: Number,
    dueDate: String,
    active: { type: Boolean, default: true },
    dailyRevenue: { type: Number, default: 0 },
    lastSeen: { type: Date, default: Date.now },
    trustUnlockUntil: { type: Date, default: null } // NOVO CAMPO: Confiança
});

const Client = mongoose.model('Client', clientSchema);

// ==========================================
// ROTAS DO PAINEL MESTRE
// ==========================================

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const masterPassword = process.env.MASTER_PASS || 'admin123';
    if (password === masterPassword) res.json({ ok: true });
    else res.status(401).json({ ok: false });
});

app.get('/api/clients', async (req, res) => {
    try {
        const clients = await Client.find();
        res.json(clients);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar clientes' });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const newClient = new Client(req.body);
        await newClient.save();
        res.json({ ok: true });
    } catch (error) {
        res.status(400).json({ ok: false, error: 'Erro ao registrar. O ID já existe.' });
    }
});

app.put('/api/clients/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await Client.findOneAndUpdate({ client_id: id }, req.body);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: 'Erro ao editar cliente' });
    }
});

// ALTERADO: Ao liberar de vez (pagamento), limpa o prazo de confiança
app.post('/api/toggle-status', async (req, res) => {
    try {
        const { client_id, active } = req.body;
        const updateData = { active };
        if (active) updateData.trustUnlockUntil = null; // Zera a confiança ao pagar
        
        await Client.findOneAndUpdate({ client_id }, updateData);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false });
    }
});

app.delete('/api/clients/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await Client.findOneAndDelete({ client_id: id });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false });
    }
});

// NOVA ROTA: Desbloqueio de Confiança
app.post('/api/trust-unlock', async (req, res) => {
    try {
        const { client_id, hours } = req.body;
        const unlockTime = new Date();
        unlockTime.setHours(unlockTime.getHours() + (hours || 24)); // Soma 24 horas
        
        await Client.findOneAndUpdate(
            { client_id }, 
            { trustUnlockUntil: unlockTime }
        );
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false });
    }
});

// ==========================================
// ROTAS DO BAR
// ==========================================

// ALTERADO: Verifica se está ativo OU se o desbloqueio de confiança ainda não venceu
app.get('/api/check-license', async (req, res) => {
    try {
        const { client_id } = req.query;
        const client = await Client.findOneAndUpdate(
            { client_id }, 
            { lastSeen: new Date() }, 
            { new: true }
        );
        
        if (client) {
            let isActive = client.active;
            
            // Lógica do Desbloqueio Temporário
            if (!isActive && client.trustUnlockUntil) {
                const now = new Date();
                const expireDate = new Date(client.trustUnlockUntil);
                if (now < expireDate) {
                    isActive = true; // Libera pois ainda está no prazo extra
                }
            }
            
            res.json({ ok: true, active: isActive });
        } else {
            res.json({ ok: false, error: 'Cliente não encontrado' });
        }
    } catch (error) {
        res.status(500).json({ ok: false });
    }
});

app.post('/api/report-revenue', async (req, res) => {
    try {
        const { client_id, dailyRevenue } = req.body;
        await Client.findOneAndUpdate({ client_id }, { dailyRevenue, lastSeen: new Date() });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 PlayBar Master Panel rodando na porta ${PORT}`);
});
