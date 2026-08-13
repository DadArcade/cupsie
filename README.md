# Cupsie prints to CUPS servers from the Chrome browser

## Install

Open [Cupsie Extension](https://chromewebstore.google.com/detail/dekecaodhfljnecmmkenlmjfcbmdokno/) on Chrome Web Store and click **Add to Chrome** button.

Cupsie makes printing from your Chrome browser simple. You just add a CUPS server, and Cupsie automatically pulls all the shared printers from it so you can print right away. 

You do not need to install any system printer drivers, and it works perfectly in Chrome browser on ChromeOS, Linux, macOS, and Windows.

## How it works

Cupsie syncs all the shared printers from CUPS server(s) to make them available in your Chrome Print dialog. Your imported printers appear directly in your regular Chrome print list. Advanced printer settings like finishing, stapling, and input/output tray selection are exposed under Advanced Settings in the Chrome Print dialog. 

If you need to, you can also connect directly to individual network printers without using a central CUPS server, as long as they are IPP-capable.

The extension syncs periodically in the background to ensure your available printer list always stays up to date. For more details, see [Architecture](https://github.com/DadArcade/cupsie/wiki/Architecture)

## Privacy

Cupsie sends your print jobs straight from your computer to your CUPS server or your printer. Your documents never go to the internet or any cloud services. Cupsie does not have permissions to connect to anything by default, it will always ask for your permission before sending a print job to a new server or printer.

---

## How to Add Printers

Open the extension **Options** page (right-click the extension icon and select **Options**, or navigate to `chrome://extensions` and click **Extension options**).

<img width="60%" alt="cupsie-options" src="https://github.com/user-attachments/assets/87864635-4732-418c-a9d9-c052735b0c46" />

### 1. Adding CUPS Print Servers
- Under **CUPS Servers**, enter your CUPS server IP addresses or URLs (one per line).
- *Example*: `http://192.168.1.10:631` or `https://cups-server.example.com`
- The extension automatically connects to each server and fetches all available printer queues.
> [!NOTE]
> If you use https, Cupsie will only connect to servers with trusted certificates.

### 2. Adding Standalone IPP Printers
- Under **Standalone IPP Printers**, enter the IPP URL of your printer and an optional friendly display name.
- *Example*:
  - **URL**: `http://192.168.1.50:631/ipp/print` or `https://cups-server.example.com/ipp`
  - **Name**: `HP Laserjet`
- Click **+ Add Another Printer** to add more printers if needed.

For more use cases, see the detailed [User Guide](https://github.com/DadArcade/cupsie/wiki/User-Guide)

## Privacy

By default, the extension has access to nothing and does not send any data to external servers. It will request network permission directly from you when adding printers.

For more details, see the full [Privacy Policy](privacy_policy.md).
