# Privacy Policy for Cupsie Printer Provider

**Effective Date:** July 23, 2026

This privacy policy explains how the **Cupsie Printer Provider** Chrome extension ("Extension", "we", "us") collects, uses, stores, and protects data when you use the Extension.

We are committed to maintaining the privacy and security of your personal data. 

---

## 1. Information Collection and Use

The Extension only accesses the minimum necessary information required to perform its core function: locating network printers and facilitating print jobs.

### A. Chrome Profile Identity (Email)
- **What is accessed**: The Extension requests access to your primary Google Account profile information (via the `chrome.identity` API).
- **Purpose**: We read your email address to extract the username prefix (e.g., `user` from `user@example.com`). This is used to check your printing authorization against enterprise-managed printer access allowlists and denylists.
- **Processing**: The evaluation is performed **entirely locally** on your machine. Your email address is never sent to us or any remote third-party service.

### B. Network Printer Information
- **What is accessed**: Printer connection URLs and IP addresses configured manually by you or distributed via enterprise policy.
- **Purpose**: The Extension connects directly to these network URLs (using standard IPP or CUPS protocols) to query printer capabilities and transmit print jobs.
- **Processing**: Print jobs and printer status queries travel directly from your local browser to the target printer endpoints. We do not inspect, intercept, or log the contents of your printed documents.

---

## 2. Data Storage and Location

All data managed by the Extension is stored locally in your Chrome browser's secure sandboxed storage:
- **`chrome.storage.sync`**: User-defined CUPS servers, standalone IPP printers, and synchronization intervals may be synchronized across your signed-in Chrome devices.
- **`chrome.storage.local`**: Troubleshooting logs and local cached printer capabilities.

No personal data, document content, or configuration information is sent to the Extension developers.

---

## 3. Data Sharing and Transfer

We do **not** collect, sell, trade, or transfer your personal data, profile identity, network configurations, or print history to any third parties. All network connections are initiated solely to communicate directly with the printers you configure.

---

## 4. Security

The Extension communicates with printers using standard web transport protocols. If you configure secure IPP printer endpoints, all network transmissions (including print jobs) are encrypted in transit using industry-standard TLS (Transport Layer Security).

---

## 5. Contact Information

If you have any questions or feedback regarding this Privacy Policy or the security of the Extension, please contact:

- **Support/Developer Email**: `[EMAIL_ADDRESS]`
- **Project Repository**: [github.com/DadArcade/cupsie](https://github.com/DadArcade/cupsie/)