import os
import asyncio
import logging
from datetime import datetime
import tempfile
import subprocess

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from flask import Flask, jsonify, send_file
import qrcode
from io import BytesIO
import threading

# Web3 WhatsApp (یہ نیا ہے اور بہتر کام کرتا ہے)
from web3whatsapp import WhatsApp
from web3whatsapp.models import Message

# Configuration
TELEGRAM_TOKEN = os.getenv('TELEGRAM_TOKEN', 'YOUR_TOKEN')
TARGET_JIDS = os.getenv('TARGET_JIDS', '').split(',') if os.getenv('TARGET_JIDS') else []
PORT = int(os.getenv('PORT', 3000))

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global variables
whatsapp_client = None
whatsapp_connected = False
whatsapp_qr = None

# Flask app for web interface
app = Flask(__name__)

# -----------------------------------------------------------------------------
# WHATSAPP FUNCTIONS
# -----------------------------------------------------------------------------
class WhatsAppHandler:
    def __init__(self):
        self.client = None
        self.connected = False
        
    async def connect(self):
        """Connect to WhatsApp"""
        global whatsapp_qr
        
        # Initialize client
        self.client = WhatsApp(
            session='whatsapp_session',
            max_qr_tries=3,
            qr_callback=self.qr_callback
        )
        
        # Connect
        await self.client.connect()
        self.connected = True
        logger.info("✅ WhatsApp Connected")
        return self.client
    
    def qr_callback(self, qr_data):
        """QR code callback"""
        global whatsapp_qr
        whatsapp_qr = qr_data
        logger.info("📱 QR Code generated")
    
    async def send_message(self, jid, content, msg_type='text', **kwargs):
        """Send message to WhatsApp"""
        if not self.client or not self.connected:
            logger.error("WhatsApp not connected")
            return False
        
        try:
            if msg_type == 'text':
                await self.client.send_message(jid, content)
            elif msg_type == 'photo':
                await self.client.send_image(jid, content, caption=kwargs.get('caption', ''))
            elif msg_type == 'video':
                # Video with thumbnail support
                await self.client.send_video(
                    jid, 
                    content, 
                    caption=kwargs.get('caption', ''),
                    thumbnail=kwargs.get('thumbnail')
                )
            elif msg_type == 'document':
                await self.client.send_file(
                    jid, 
                    content, 
                    filename=kwargs.get('filename', 'file'),
                    caption=kwargs.get('caption', '')
                )
            elif msg_type == 'audio':
                if kwargs.get('voice', False):
                    await self.client.send_voice(jid, content)
                else:
                    await self.client.send_audio(jid, content, caption=kwargs.get('caption', ''))
            return True
        except Exception as e:
            logger.error(f"Error sending to WhatsApp: {e}")
            return False

# -----------------------------------------------------------------------------
# TELEGRAM HANDLERS
# -----------------------------------------------------------------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Start command"""
    await update.message.reply_text(
        "👋 Welcome to WhatsApp Forwarder Bot!\n\n"
        "Send any media and it will be forwarded to WhatsApp.\n"
        "Commands:\n/status - Check connection status"
    )

async def status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Check status"""
    global whatsapp_connected, TARGET_JIDS
    
    status_text = f"📱 WhatsApp: {'✅ Connected' if whatsapp_connected else '❌ Disconnected'}\n"
    status_text += f"🎯 Targets: {len(TARGET_JIDS)}\n"
    
    if TARGET_JIDS:
        for i, jid in enumerate(TARGET_JIDS, 1):
            status_text += f"  {i}. {jid}\n"
    
    await update.message.reply_text(status_text)

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle all messages from Telegram"""
    global whatsapp_client, whatsapp_connected, TARGET_JIDS
    
    if not whatsapp_connected or not TARGET_JIDS:
        await update.message.reply_text("❌ WhatsApp not connected or no targets configured")
        return
    
    msg = await update.message.reply_text("🔄 Processing...")
    
    try:
        # TEXT
        if update.message.text:
            for jid in TARGET_JIDS:
                await whatsapp_client.send_message(jid, update.message.text)
            await msg.edit_text("✅ Text forwarded!")
        
        # PHOTO
        elif update.message.photo:
            file = await update.message.photo[-1].get_file()
            photo_data = await file.download_as_bytearray()
            
            for jid in TARGET_JIDS:
                await whatsapp_client.send_message(
                    jid, 
                    photo_data, 
                    msg_type='photo',
                    caption=update.message.caption or ''
                )
            await msg.edit_text("✅ Photo forwarded!")
        
        # VIDEO
        elif update.message.video:
            file = await update.message.video.get_file()
            
            # Download video
            await msg.edit_text("📥 Downloading video...")
            video_bytes = await file.download_as_bytearray()
            
            # Generate thumbnail (first frame)
            await msg.edit_text("🖼️ Generating thumbnail...")
            thumbnail = await extract_thumbnail(video_bytes)
            
            # Send to WhatsApp
            await msg.edit_text("📤 Sending to WhatsApp...")
            for jid in TARGET_JIDS:
                await whatsapp_client.send_message(
                    jid,
                    video_bytes,
                    msg_type='video',
                    caption=update.message.caption or '',
                    thumbnail=thumbnail
                )
            await msg.edit_text("✅ Video forwarded with thumbnail!")
        
        # DOCUMENT
        elif update.message.document:
            file = await update.message.document.get_file()
            doc_bytes = await file.download_as_bytearray()
            filename = update.message.document.file_name
            
            for jid in TARGET_JIDS:
                await whatsapp_client.send_message(
                    jid,
                    doc_bytes,
                    msg_type='document',
                    filename=filename,
                    caption=update.message.caption or ''
                )
            await msg.edit_text("✅ Document forwarded!")
        
        # AUDIO
        elif update.message.audio or update.message.voice:
            file = await (update.message.audio or update.message.voice).get_file()
            audio_bytes = await file.download_as_bytearray()
            is_voice = bool(update.message.voice)
            
            for jid in TARGET_JIDS:
                await whatsapp_client.send_message(
                    jid,
                    audio_bytes,
                    msg_type='audio',
                    voice=is_voice,
                    caption=update.message.caption or ''
                )
            await msg.edit_text("✅ Audio forwarded!")
        
        # STICKER
        elif update.message.sticker:
            file = await update.message.sticker.get_file()
            sticker_bytes = await file.download_as_bytearray()
            
            for jid in TARGET_JIDS:
                await whatsapp_client.send_message(
                    jid,
                    sticker_bytes,
                    msg_type='sticker'
                )
            await msg.edit_text("✅ Sticker forwarded!")
            
    except Exception as e:
        logger.error(f"Error: {e}")
        await msg.edit_text(f"❌ Error: {str(e)}")

async def extract_thumbnail(video_bytes):
    """Extract thumbnail from video using ffmpeg"""
    with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as vf:
        vf.write(video_bytes)
        vf_path = vf.name
    
    with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tf:
        thumb_path = tf.name
    
    try:
        # Use ffmpeg to extract first frame
        cmd = [
            'ffmpeg',
            '-i', vf_path,
            '-ss', '00:00:01',
            '-vframes', '1',
            '-vf', 'scale=320:240',
            '-f', 'image2',
            '-y', thumb_path
        ]
        
        subprocess.run(cmd, capture_output=True, timeout=10)
        
        # Read thumbnail
        with open(thumb_path, 'rb') as f:
            thumbnail = f.read()
        
        return thumbnail
    except:
        return None
    finally:
        # Cleanup
        os.unlink(vf_path)
        if os.path.exists(thumb_path):
            os.unlink(thumb_path)

# -----------------------------------------------------------------------------
# WHATSAPP CONNECTION MANAGER
# -----------------------------------------------------------------------------
async def manage_whatsapp():
    """Background task for WhatsApp connection"""
    global whatsapp_client, whatsapp_connected
    
    handler = WhatsAppHandler()
    
    while True:
        try:
            if not whatsapp_connected:
                logger.info("Connecting to WhatsApp...")
                whatsapp_client = await handler.connect()
                whatsapp_connected = True
        except Exception as e:
            logger.error(f"WhatsApp connection error: {e}")
            whatsapp_connected = False
            await asyncio.sleep(5)
        
        await asyncio.sleep(1)

# -----------------------------------------------------------------------------
# FLASK ROUTES (for QR code)
# -----------------------------------------------------------------------------
@app.route('/')
def index():
    return send_file('public/index.html')

@app.route('/api/status')
def api_status():
    global whatsapp_qr, whatsapp_connected
    
    # Generate QR data URL if available
    qr_data_url = None
    if whatsapp_qr:
        img = qrcode.make(whatsapp_qr)
        buffer = BytesIO()
        img.save(buffer, format='PNG')
        qr_data_url = 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()
    
    return jsonify({
        'connected': whatsapp_connected,
        'qr': qr_data_url,
        'targets': TARGET_JIDS,
        'telegram': bool(TELEGRAM_TOKEN and TELEGRAM_TOKEN != 'YOUR_TOKEN')
    })

def run_flask():
    app.run(host='0.0.0.0', port=PORT)

# -----------------------------------------------------------------------------
# MAIN
# -----------------------------------------------------------------------------
async def main():
    # Start Flask in background
    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()
    
    # Start WhatsApp connection manager
    asyncio.create_task(manage_whatsapp())
    
    # Start Telegram bot
    if TELEGRAM_TOKEN and TELEGRAM_TOKEN != 'YOUR_TOKEN':
        telegram_app = Application.builder().token(TELEGRAM_TOKEN).build()
        
        # Add handlers
        telegram_app.add_handler(CommandHandler("start", start))
        telegram_app.add_handler(CommandHandler("status", status))
        telegram_app.add_handler(MessageHandler(filters.ALL & ~filters.COMMAND, handle_message))
        
        logger.info("🤖 Telegram Bot started")
        await telegram_app.run_polling()
    else:
        logger.warning("⚠️ Telegram token not configured")
        # Keep running for WhatsApp QR only
        while True:
            await asyncio.sleep(1)

if __name__ == '__main__':
    # Install required packages first:
    # pip install python-telegram-bot web3whatsapp flask qrcode pillow
    
    import base64
    asyncio.run(main())
