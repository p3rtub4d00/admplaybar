import express from 'express';
import cors from 'cors'; // <-- CORS importado
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MercadoPagoConfig, Payment } from 'mercadopago';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// <-- CORS ativado para não bloquear o painel do bar
app.use(cors()); 

app.use(express.json());
app.use(express.static('public'));

// Inicializa o cliente do Mercado Pago usando a variável de ambiente
const clientMP = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || 'SEU_ACCESS_TOKEN_AQUI' });

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
    if (!client.active || !client.dueDate) return client;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const [y, m, d] = client.dueDate.split('-');
    const dueDate = new Date(y, m - 1, d);
    
    if (dueDate < today) {
        client.active = false;
        await client.save();
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
// ROTA PARA GERAR O PIX DE PAGAMENTO DO CLIENTE
// ==========================================
app.post('/api/create-pix', async (req, res) => {
    try {
        const { client_id } = req.body;
        const client = await Client.findOne({ client_id });

        if (!client) {
            return res.status(404).json({ ok: false, error: 'Cliente não encontrado' });
        }

        const payment = new Payment(clientMP);
        const body = {
            transaction_amount: Number(client.value) || 99.90,
            description: `Renovação Mensalidade PlayBar - ${client.name || client_id}`,
            payment_method_id: 'pix',
            payer: {
                email: `bar_${client_id}@playbar.com`,
                first_name: client.name || 'Cliente PlayBar'
            },
            external_reference: client_id,
            // <-- LINHA ADICIONADA: Aviso de pagamento para liberar o sistema automaticamente
            notification_url: 'https://admplaybar.onrender.com/api/webhook/mercadopago' 
        };

        const response = await payment.create({ body });

        res.json({
            ok: true,
            qr_code: response.point_of_interaction.transaction_data.qr_code,
            qr_code_base64: response.point_of_interaction.transaction_data.qr_code_base64
        });
    } catch (error) {
        console.error('Erro ao gerar PIX no Mercado Pago:', error);
        res.status(500).json({ ok: false, error: 'Erro ao gerar pagamento PIX' });
    }
});

// ==========================================
// ROTA DE WEBHOOK DO MERCADO PAGO (PIX AUTOMÁTICO)
// ==========================================
app.post('/api/webhook/mercadopago', async (req, res) => {
    try {
        const body = req.body;

        if (body.type === 'payment' || body.action === 'payment.created' || body.data) {
            const paymentId = body.data?.id || body.id;

            if (paymentId) {
                const payment = new Payment(clientMP);
                const paymentInfo = await payment.get({ id: paymentId });

                if (paymentInfo && paymentInfo.status === 'approved') {
                    const clientId = paymentInfo.external_reference;

                    if (clientId) {
                        const client = await Client.findOne({ client_id: clientId });
                        
                        if (client) {
                            const nextDueDate = new Date();
                            nextDueDate.setDate(nextDueDate.getDate() + 30);
                            const formattedDueDate = nextDueDate.toISOString().split('T')[0];

                            client.active = true;
                            client.dueDate = formattedDueDate;
                            client.trustUnlockUntil = null;
                            await client.save();

                            console.log(`[PIX APROVADO] Bar ${clientId} regularizado automaticamente via Webhook! Novo vencimento: ${formattedDueDate}`);
                        }
                    }
                }
            }
        }

        res.status(200).json({ received: true });
    } catch (error) {
        console.error('Erro no Webhook do Mercado Pago:', error);
        res.status(500).json({ error: 'Erro ao processar webhook' });
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
            client = await checkAutoBlock(client);
            
            client.lastSeen = new Date();
            await client.save();

            let isActive = client.active;
            
            if (!isActive && client.trustUnlockUntil) {
                const now = new Date();
                const expireDate = new Date(client.trustUnlockUntil);
                if (now < expireDate) {
                    isActive = true; 
                } else {
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
