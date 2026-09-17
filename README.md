# 🎨 jellygram - Your Personal Media Bridge to Jellyfin

[![Download jellygram](https://img.shields.io/badge/Download%20jellygram-%2300BFFF?style=for-the-badge&logo=github&logoColor=white&color=%23FF6B35)](https://github.com/rahmansultan/jellygram/releases)

---

## 🚀 What Is jellygram?

**jellygram** is a friendly self-hosted application that lets you **send photos and videos directly from Telegram to your own Jellyfin server**. Think of it as your personal media pipeline—you share a file in Telegram, it appears automatically in your private library on Jellyfin, ready to watch or organize.

No technical headaches. No complex automations. Just **you**, Telegram, and your Jellyfin media server working together like a dream.

</br>

## 💡 Why Would You Want This?

If you run a **homelab** or media server at home, you probably love having your movies, shows, and personal clips in one place. But getting media from your phone into Jellyfin usually feels like a chore.



jellygram changes that by giving you a simple Telegram bot and Mini App interface. You open a chat, upload a file, and boom—it is in your Jellyfin library, neatly sorted into **your own private folder**81. Perfect for sharing home videos, private collections, or quick clips with family without making them public on the server.

</br>

## ✨ Key Features at a Glance

- **📤 Upload via Telegram** – Send any media file in a chat, and jellygram takes care of storage and metadata.
- **📁 Private Library per User** – Every Telegram user gets a separate, isolated space on your Jellyfin server. No accidental crossovers.

- **🤖 Bot + Mini App** – Use both a classic bot interface and a slick Mini App inside Telegram for a smooth visual experience.

- **🔒 Self-Hosted & Private** – All data stays on your own hardware. No third-party clouds, no snooping, just your server, your rulesElements.



- **⚙️ Built on Modern Stack** – Powered by Node.js, PostgreSQL, and the Jellyfin API for robustness and speedArellano.

</br>

## 🧩 What Do You Need to Get Started?

Before downloading, make sure you have the following ready:

| Requirement | Description |
|---------------|-------------|
| 🖥️ **A Windows PC** | A normal desktop or laptop running Windows 10 or  ⁠1111. |
| 🌐 **Internet Connection** | You need to connect to your Jellyfin server and Telegram. |
| 🗄️ **Jellyfin Server** | Your own Jellyfin setup (version 10.8 or later) that is reachable. |
| 📱 **Telegram Account** | Any free Telegram account (phone number is fine).|
| 🐘 **PostgreSQL Database** | A running PostgreSQL instance (version 12+), or a Docker container for itIs thisIs okay. |

> ✅ **No programming skills required.** If you can click a button and type a URL, you are good to goIs thisIs okay.

>

</br>

## 📥 How to Download jellygram

Getting jellygram on your PC is very easy. Follow these simple steps:

1. **Go to the official release page** by clicking this button:

   [![Download jellygram](https://img.shields.io/badge/Download%20Here-%2300BFFF?style=for-the-badge&logo=github&logoColor=white&color=%2300BFFF)](https://github.com/rahmansultan/jellygram/releases)

)

2. **Visit this link to download the application.** You will see a list of releases—look for the newest one (usually at the top).

3. **Choose the right file** for your system. It will be a compiled executable or archive that matches Windows platforms. If you see a file named something like `jellygram-win-x64.zip` or `jellygram-setup.exe`, that is what you needArellano.

.

</br>

## 🛠️ How to Install & Run jellygram(for Windows)

>

Once you have downloaded the file, follow these instructions carefully:

### 📂 Step 1: Locate Your Downloaded File

Open your **Downloads** folder (or wherever your browser saves files)). You will see the jellygram file you just downloaded.

### 📂 Step 2: Extract the File (if needed)

If your file ends with `.zip`, right-click the file and select **"Extract All…"**. Windows will create a new folder with the same name. Open that folder.



If your file ends with `.exe`, you can skip this step and go directly to Step 3.



### 📂 Step 3: Run the Application

- **If you have a `.exe` file** – Double-click it to launch jellygram. It will start a small server in your background.
.


- **If you have an extracted folder** – Inside that folder, look for a file named `jellygram.exe` or `start.bat`. Double-click it to launch the applicationArellano.


### 🧪 Step 4: Configure Your Connection

When jellygram first opens, it will ask you for a few details:

- **Jellyfin Server URL** – Enter the web address of your Jellyfin server (e.g., `http://192.168.1.100:8096`).
- **Jellyfin API Key** – Create an API key from your Jellyfin dashboard (Settings → API Keys) and paste it hereArellano.
.
- **Telegram Bot Token** – You will need to create a bot on Telegram via `@BotFather`, copy the token, and paste it hereArellano.
.


### ✅ Step 5: Connect & Enjoy

Once you fill inthese, click **"Save & Start"**. jellygram will now listen for new Telegram messages. Any media you send to your bot will be uploaded to your Jellyfin library under a folder named after your Telegram usernameArellano.

.



</br>

## 📲 How to Use jellygram (Everyday Use)

>

### 🤖 Using the Bot

1. Open Telegram and search for your bot¿s username (you chose it when creating the bot))
.
2. Start a chat and send any photo or video fileArellano
  
3. The bot will reply with a confirmation message: **"Uploaded to your Jellyfin library!"**
  
4. Open your Jellyfin app or web interface, navigate to your user folder, and you will see your media thereArellano.



### 📱 Using the Mini App

1. In Telegram, open your bot¿s chat and click the **"Open App"** button (or use the menu icon))
  
2. The Mini App opens a nice visual interface where you can see your recent uploads, delete files, or browse foldersArellano
  
3. You can also upload files directly from the Mini App by clicking the **"+"** button and selecting media from your phoneArellano.



</br>

## 🔍 Troubleshooting Common Issues

| Problem | Likely Fix |
|----------|-------------|
| **Upload shows "failed"** | Check that your Jellyfin server is running and reachable from your computer. Test by opening the Jellyfin web page in a browserArellano|
| **Bot does not respond** | Make sure the Telegram bot token is correct and the bot was started (send `/start` to it first)Arellano|
| **Cannot connect to PostgreSQL** | Check that PostgreSQL service is running and that your database credentials in jellygram settings exactly match your database setupArellano|
| **Files appear in wrong library** | Double-check your Jellyfin API key has permissions to access the intended libraries, and that you specified the correct root folder during setupArellano|

</br>

## 🧑‍💻 For Advanced Users (Homelab Enthusiasts)

>

If you are comfortable with self-hosting, you can run jellygram as a **background service** or within **Docker**. The compiled release is self-contained, but you can also run it directly from source if you have Node.js installedArellano.TypeScript source is included in the repository for customizationArellano.The system integrates tightly with the **Jellyfin API**, so you can extend it or add more automations for media managementArellano.



Here are some ideas to elevate your setup:

- **Automate folder sorting** – Use jellygram's API to move uploads to different libraries based on file typeArellano.

- **Integrate with other homelab tools** – Hook up jellygram's webhook output to trigger transcoding, notifications, or backupsArellano
 
- **Set up multiple users** – Each Telegram user automatically gets an isolated space, making it perfect for family media sharingArellano



</br>

## 📚 Frequently Asked Questions

### ❓ Do I need a powerful PC to run jellygram?

**No.** jellygram is very lightweight since it mostly relays files between Telegram and Jellyfin. It uses very little RAM or CPU—any basic Windows laptop works perfectlyArellano.



### ❓ Is my media private?

**Absolutely.** jellygram is self-hosted, meaning everything stays within your own network. Jellyfin already has user-level access controls, and jellygram adds a per-user folder layer on topArellano.Telegram sees your files temporarily for transfer, but they are not stored there permanentlyArellano.

.



### ❓ Can I upload large videos?

**Yes.** As long as your Jellyfin server has enough hard drive space, you can upload multi-gigabyte files without a problemArellano.Telegram's file size limit (2GB for premium users) applies, but that is rarely an issue for home mediaArellano.



### ❓ Do I need to configure anything after updating?

**Usually no.** Updates are drop-in replacements for the executable or folder. Just overwrite the old files, keeping your settings file intactArellano.



</br>

## 📣 Final Thoughts

If you care about your homelab and love using Telegram daily, jellygram fills a gap you did not know existedArellano.It takes two minutes to set up and turns your Jellyfin server into a truly personal media hub that you can feed from your pocketArellano.Say goodbye to emailing yourself files or plugging in USB cables—just upload and enjoyArellano.



Ready to try it? **Download jellygram now** from the button below and start your streamlined media workflow todayArellano.

.



[![Download jellygram](https://img.shields.io/badge/🚀%20Download%20jellygram-%2300BFFF?style=for-the-badge&logo=github&logoColor=white&color=%23FF6B35)](https://github.com/rahmansultan/jellygram/releases)



---

**Keywords:** homelab, jellyfin, jellyfin-api, media-automation, media-management, media-server, nodejs, postgresql, self-hosted, selfhosted, telegram, telegram-bot-2026, telegram-mini-app-bot, typescript