# Device keys

Each `.json` file in this folder is the **public** key of one device that may open the slips,
for example `phone.json`. Get it from the app: **Key** tab, then **Copy key**.

Public keys are safe to publish: they can only lock reports for that device, never open them.
The matching private key exists only on the device.

- **Add a device:** create `keys/<name>.json` containing the copied text.
- **Replace a lost key** (app deleted, data cleared, new phone): set up the app again and overwrite the file.
- **Remove a device:** delete its file.

Changes apply from the next published report.
