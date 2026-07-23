# Cupsie Printer Provider

**Cupsie Printer Provider** is a Chrome extension that allows to add CUPS print queues and standalone IPP/IPPS printers directly into the native Chrome Print Dialog using Chrome's `printerProvider` API.

---

## What It Does

- **Native Chrome Print Integration**: Integrates IPP/CUPS printers into the Chrome browser print destination picker.
- **CUPS Server Auto-Discovery**: Connects to CUPS servers and automatically discovers all exposed printer queues.
- **Standalone IPP/IPPS Support**: Connects directly to IPP/IPPS print endpoints on standalone printers without requiring a central print server.
- **Advanced Capabilities & Attributes**: Automatically queries printer capabilities via IPP (paper sizes, tray selection, paper type, duplex, color, print scaling, stapling, hole punching, folding, etc.) and maps them to Chrome print settings.
- **Enterprise Policy Support**: Fully configurable via Chrome Extension Managed Storage policy (`schema.json`) for enterprise deployments.
- **Built-in Troubleshooting**: Includes a logging and diagnostic UI to view printer response codes and status.

---

## How to Add Printers

Open the extension **Options** page (right-click the extension icon and select **Options**, or navigate to `chrome://extensions` and click **Extension options**).

### 1. Adding CUPS Print Servers
- Under **CUPS Servers**, enter your CUPS server IP addresses or URLs (one per line).
- *Example*: `http://192.168.1.10:631` or `https://cups-server.example.com`
- The extension automatically connects to each server and fetches all available printer queues.

### 2. Adding Standalone IPP Printers
- Under **Standalone IPP Printers**, click **+ Add Printer**.
- Enter the direct IPP URL endpoint and an optional friendly display name.
- *Example*:
  - **URL**: `http://192.168.1.50:631/ipp/print` or `https://cups-server.example.com/ipp/print`
  - **Name**: `Office Color Laser`

### 3. Background Sync Interval
- Adjust the **Background Sync Interval (minutes)** to control how frequently Cupsie polls your servers and printers for state changes.
- Click **Save Settings** to persist your configuration and trigger an immediate printer sync.

---

## How to Set Enterprise Policy

Enterprise IT administrators can deploy and enforce printer configurations across organization-managed Chrome devices using Chrome Managed Storage policies.

### Managed Policy Schema (`schema.json`)

| Policy Key | Type | Description |
| :--- | :--- | :--- |
| `cupsServers` | Array of Strings | Enterprise CUPS print server URLs/IPs (e.g., `["http://cups.domain.local:631"]`). |
| `ippPrinters` | Array of Objects | Direct IPP printers with `url` (string) and optional `name` (string). |
| `syncInterval` | Integer | Background sync interval in minutes (1–1440). |

### Example Policy JSON

```json
{
  "cupsServers": {
    "Value": [
      "http://cups-server.internal:631"
    ]
  },
  "ippPrinters": {
    "Value": [
      {
        "url": "http://10.0.1.54:631/ipp/print",
        "name": "HQ 1sr Floor Copier"
      },
      {
        "url": "http://10.0.1.55:631/ipp/print",
        "name": "HQ 2nd Floor Copier"
      }
    ]
  },
  "syncInterval": {
    "Value": 1440
  }
}
```

### How to Deploy Policy

1. Open the **Google Admin Console**.
2. Go to **Devices > Chrome > Apps & extensions > Users & browsers**.
3. Select **Cupsie Printer Provider**.
4. Under **Policy for extensions**, paste your JSON policy.

---

## Privacy

By default, the extension has access to nothing and does not send any data to external servers. It will request network permission directly from you when adding printers.

For more details, see the full [Privacy Policy](privacy_policy.md).
