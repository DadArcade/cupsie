# Cupsie Printer Provider

**Cupsie Printer Provider** is a Chrome extension that allows to add CUPS print queues and standalone IPP/IPPS printers directly into the native Chrome Print Dialog using Chrome's `printerProvider` API.

## Install it from the Chrome Web Store

Open [Cupsie Extension](https://chromewebstore.google.com/detail/dekecaodhfljnecmmkenlmjfcbmdokno/) on Chrome Web Store and click **Add to Chrome** button.

---

## What It Does

- **Native Chrome Print Integration**: Integrates IPP/CUPS printers into the Chrome browser print destination picker.
- **CUPS Server Auto-Discovery**: Connects to CUPS servers and automatically discovers all exposed printer queues.
- **Standalone IPP/IPPS Support**: Connects directly to IPP/IPPS print endpoints on standalone printers without requiring a central print server.
- **Advanced Capabilities & Attributes**: Automatically queries printer capabilities via IPP (paper sizes, tray selection, paper type, duplex, color, print scaling, stapling, hole punching, folding, etc.) and maps them to Chrome print settings.

- **Built-in Troubleshooting**: Includes a logging and diagnostic UI to view printer response codes and status.

---

## How to Add Printers

Open the extension **Options** page (right-click the extension icon and select **Options**, or navigate to `chrome://extensions` and click **Extension options**).

### 1. Adding CUPS Print Servers
- Under **CUPS Servers**, enter your CUPS server IP addresses or URLs (one per line).
- *Example*: `http://192.168.1.10:631` or `https://cups-server.example.com`
- The extension automatically connects to each server and fetches all available printer queues.

### 2. Adding Standalone IPP Printers
- Under **Standalone IPP Printers**,enter the direct IPP URL endpoint and an optional friendly display name.
- *Example*:
  - **URL**: `http://192.168.1.50:631/ipp/print` or `https://cups-server.example.com/ipp/print`
  - **Name**: `Office Color Laser`
- Click **+ Add Another Printer** to add more printers if needed.

### 3. Background Sync Interval
- Adjust the **Background Sync Interval (minutes)** to control how frequently Cupsie polls your servers and printers for state changes.
- Click **Save Settings** to persist your configuration and trigger an immediate printer sync.



## Privacy

By default, the extension has access to nothing and does not send any data to external servers. It will request network permission directly from you when adding printers.

For more details, see the full [Privacy Policy](privacy_policy.md).
