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
    trustUnlockUntil: { type: Date, default: null } 
});

const Client = mongoose.model('Client', clientSchema);

// ==========================================
// FUNÇÃO INTELIGENTE DE AUTO-BLOQUEIO
// ==========================================
async function checkAutoBlock(client) {
    // Se já está bloqueado ou não tem data, ignora
    if (!client.active || !client.dueDate) return client;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Zera as horas para comparar só o dia
    
    const [y, m, d] = client.dueDate.split('-');
    const dueDate = new Date(y, m - 1, d);
    
    // Se a data de vencimento é menor que hoje (ou seja, virou meia-noite do dia seguinte)
    if (dueDate < today) {
        client.active = false; // Bloqueia!
        await client.save();   // Salva no banco de dados automaticamente
    }
    return client;
}

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
        let clients = await Client.find();
        
        // Varre todos os clientes aplicando a regra do bloqueio automático
        for (let i = 0; i < clients.length; i++) {
            clients[i] = await checkAutoBlock(clients[i]);
        }
        
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

app.post('/api/toggle-status', async (req, res) => {
    try {
        const { client_id, active } = req.body;
        const updateData = { active };
        
        // Se você liberar o cliente manualmente, zera a trava de confiança
        if (active) updateData.trustUnlockUntil = null; 
        
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

app.post('/api/trust-unlock', async (req, res) => {
    try {
        const { client_id, hours } = req.body;
        const unlockTime = new Date();
        unlockTime.setHours(unlockTime.getHours() + (hours || 24)); 
        
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

app.get('/api/check-license', async (req, res) => {
    try {
        const { client_id } = req.query;
        let client = await Client.findOne({ client_id });
        
        if (client) {
            // Se o bar conectar e estiver vencido, bloqueia ele na hora
            client = await checkAutoBlock(client);
            
            // Grava a última vez que o bar deu sinal de vida
            client.lastSeen = new Date();
            await client.save();

            let isActive = client.active;
            
            // Verifica o "Desbloqueio de Confiança"
            if (!isActive && client.trustUnlockUntil) {
                const now = new Date();
                const expireDate = new Date(client.trustUnlockUntil);
                if (now < expireDate) {
                    isActive = true; // Libera a tela do bar
                } else {
                    // O prazo de confiança acabou! Limpa o botão para travar de vez
                    client.trustUnlockUntil = null;
                    await client.save();
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
