# Cupsie User Guide & Instructions

Welcome to **Cupsie**, the Chrome extension that brings native CUPS print server queues and standalone IPP/IPPS network printers directly into your Chrome browser's print dialog.

This guide provides step-by-step instructions on:
1. [Installing the Extension from the Chrome Web Store](#1-installing-from-the-chrome-web-store)
2. [Configuring Printers and CUPS Servers](#2-configuring-printers-and-cups-servers)
3. [Managing Permissions & Connection Prompts](#3-managing-permissions--connection-prompts)
4. [Printing with Cupsie](#4-printing-with-cupsie)
5. [Troubleshooting & Support](#5-troubleshooting--support)

---

## 1. Installing from the Chrome Web Store

Open [Cupsie Extension](https://chromewebstore.google.com/detail/dekecaodhfljnecmmkenlmjfcbmdokno/) on Chrome Web Store and click **Add to Chrome** button.

---

## 2. Configuring Printers and CUPS Servers

1. Click the **Cupsie extension icon** on your toolbar and choose **Options**.
2. *Alternatively*: Right-click the Cupsie icon and select **Options**, or go to `chrome://extensions`, find **Cupsie**, click **Details**, and click **Extension options**.

This will open the `options.html` page:

<img width="50%" alt="options-screenshot" src="https://github.com/user-attachments/assets/cc96a267-8845-43c9-9119-b10910ef2f48" />

### Adding CUPS Servers
If your printers are hosted on a central CUPS server:
1. Locate the **CUPS Servers** section.
2. In the text area, enter the URL or IP address of your CUPS servers, one per line.
   * *Example:*
     ```text
     http://192.168.1.10:631
     https://cups-server.local
     ```
3. Cupsie will query the CUPS server at each address and automatically discover all available print queues configured on it that you have access to. 
   > [!NOTE]
   > If you use https, Cupsie will only connect to servers with trusted certificates.

<details>
<summary>🔑 <b>Username-Based Printer Access</b></summary>
<br>

Access to certain printers and queues may depend on your Chrome profile's username:
* **How Cupsie identifies you**: Cupsie retrieves the email address of the active logged-in Google Account in Chrome (e.g., `username@example.com`) and extracts the username prefix before the `@` symbol (in this case, `username`).
* **Printer Visibility**: If a printer on a CUPS server is configured with allowlists or denylists, Cupsie will only discover and show that printer if your username is authorized to use it.
* **Printing Permissions**: If you manually configure a standalone printer that restricts access, print jobs will fail with a "Not authorized" or "Access denied" warning if your username does not have printing rights.
* **If a printer is missing**: Please contact your printer administrator to verify that your username is on the printer's allowlist.
</details>


### Adding Standalone IPP/IPPS Printers
If you have a printer connected directly to your network without a print server:
1. Locate the **Standalone IPP Printers** section.
2. Enter the details:
   * **URL**: The direct IPP or HTTP printer endpoint address.
     * *Example:* `ipp://192.168.1.50:631/ipp/print` or `http://10.0.1.25/ipp/print`
   * **Name** (Optional): A friendly nickname for the printer (e.g., `Office Color Laser`).
3. You can add multiple standalone printers by clicking **+ Add Printer** and adding more lines.

<details>
<summary><b>Customizing the Sync Interval</b></summary>
<br>
By default, Cupsie automatically refreshes printer status and capabilities in the background.
1. Scroll to the **Background Sync Interval** field.
2. Input the interval in minutes.
   * *Example:* Set to `1440` (24 hours) for stable network printers, or a lower number (like `60` minutes) if printers are frequently turned on/off or change IPs.
3. The minimum allowed value is `1` minute.
</details>

## 3. Managing Permissions & Connection Prompts

Because Chrome enforces strict security policies to protect your privacy, extensions cannot silently access devices on your local network. 

### Granting Network Permissions
1. Once you finish configuring your servers and printers, click the blue **Save Settings** button at the bottom of the page.
2. **Crucial Step**: Chrome will display a popup requesting permission to access the server/printer URLs you entered.
   > [!IMPORTANT]
   > You must click **Allow** or **Grant** in the Chrome prompt. If you deny this request, Chrome blocks Cupsie from communicating with your printers, and the sync will fail.
3. Once allowed, you will see a green success message: **"Settings saved and printers synced!"** and a list of discovered queues under **Sync Results**.

<img width="458" height="279" alt="cupsie-permissions" src="https://github.com/user-attachments/assets/a9630987-bf0e-4cd0-8f6b-f0f4d2f2dfb5" />

### Managing Synced Devices (Multiple Computers)
If you sign in to Chrome on a second computer:
1. Chrome Sync automatically syncs your printer list and URLs to the new machine.
2. However, Chrome security policies prevent host permissions from syncing across devices.
3. When you open the Options page on your new machine, a yellow warning banner will say:
   `Connection permissions for some synced printers are missing on this device. Please click 'Save Settings' to grant access.`
4. Click **Save Settings** and approve the local permission request to enable printing on this machine.

---

## 4. Printing with Cupsie

Once configured, printing is simple:

1. Press `Ctrl + P` (Windows/Linux) or `Cmd + P` (macOS) in Chrome to open the standard print dialog.
2. In the **Destination** dropdown, select your Cupsie printer. (Cupsie printers are indicated under the list of available targets).
3. If desired, expand **More settings** or look under advanced capabilities to choose options like:
   * Input/Output Trays
   * Paper Type
   * Finishing options (Stapling, Hole Punching, etc.)
   * Print Scaling
4. Settings left as **"Use Printer Default"** will use the default settings configured directly on the physical printer or CUPS server.
5. Click **Print**!

---

## 5. Troubleshooting & Support

If your printers are not showing up or you encounter printing issues:

* **Check the Sync Results**: Scroll down to the **Sync Results** section on the options page to see the status of each configured server/printer connection.
* **Access Logs**: Click the **View Troubleshooting Logs →** link on the options page. This opens a dedicated logs page showing the last 24 events.
* **Download Logs**: Click **Download Log** to save the logs as a text file to share with your system administrator or IT helpdesk.
* **Common Errors**:
  * *HTTP 401/403 (Unauthorized / Access Denied)*: The CUPS server has access control lists restricting your username. Ensure your Chrome account username is on the server's allowlist.
  * *Network error*: Verify the printer or CUPS server is powered on, connected to the same network as your computer, and the IP/URL address is correct.
  * *Proxy or Firewall Block (Non-IPP response / Proxy error)*: If you are on an enterprise network, a proxy or firewall might be intercepting Cupsie's requests. Ensure your printer endpoints are configured to bypass proxies, or verify your proxy credentials if proxy authentication (HTTP 407) is required.
