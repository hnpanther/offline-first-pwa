package com.hnp.mfdcs;

import android.app.Activity;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.Ndef;
import android.os.Bundle;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;

/**
 * Reading NFC tags inside the packaged app.
 *
 * <h2>Why this exists</h2>
 *
 * The web app reads tags with <b>Web NFC</b> ({@code window.NDEFReader}), which is a Chrome API.
 * Android's WebView does not implement it — inside the packaged app the constructor is simply
 * absent, so scanning is not denied or broken, it is missing. This plugin puts {@link NfcAdapter}
 * behind the same door, so {@code services/nfc} can choose a reader and everything above it stays
 * unchanged.
 *
 * <h2>The contract with the web side: emit what Web NFC would have emitted</h2>
 *
 * Every record crosses the bridge as <b>base64 bytes</b> plus a {@code recordType} drawn from Web
 * NFC's vocabulary, and those bytes are what Web NFC would have handed the page — not what is
 * physically on the tag. Web NFC normalises two well-known record types before the page sees
 * them, and so does this class:
 *
 * <ul>
 *   <li><b>text</b> — an NDEF text payload opens with a status byte whose low bits give the
 *       length of a language code, then that code, then the text. Both are stripped here. Left
 *       in, the shared decoder would see a longer string, prefer it, and read {@code ASSET-42} as
 *       {@code <STX>enASSET-42} — an id that matches no asset, with nothing on screen to say
 *       why.</li>
 *   <li><b>uri</b> — the first byte indexes a prefix table ({@code 0x04} = {@code https://}).
 *       It is expanded here.</li>
 * </ul>
 *
 * <p>Both are also re-encoded to UTF-8, so a UTF-16 tag decodes correctly on a side that only
 * decodes UTF-8. Everything else passes through byte-for-byte.
 *
 * <h2>And nothing beyond those two</h2>
 *
 * Those rules are fixed by the NFC Forum spec and cannot drift. Everything <i>else</i> about
 * reading a tag — records that are mislabelled, media types that lie, which of several records
 * actually holds the asset id — is heuristics learned from tags in this plant, and lives once, in
 * TypeScript, in {@code decodeRecordData}. A second copy here would drift from it the first time
 * either was fixed, and a tag would then read differently depending on whether the operator was
 * in Chrome or in the app: the worst way for this to fail, and the hardest to notice.
 *
 * <h2>Reader mode, not foreground dispatch</h2>
 *
 * {@code enableReaderMode} keeps the tag inside this activity instead of broadcasting an intent
 * that could hand the tag to another app, or bounce our own activity through
 * {@code onNewIntent} and tear down the WebView mid-shift. It is bound to the activity lifecycle
 * below: Android requires a resumed activity, so a scan that outlives a screen-off would
 * otherwise die silently and never come back.
 */
@CapacitorPlugin(name = "Nfc")
public class NfcPlugin extends Plugin {

    /** RTD URI prefixes, NFC Forum RTD-URI 1.0 section 3.2.2. Index 0 means "no prefix". */
    private static final String[] URI_PREFIXES = {
        "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:",
        "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://",
        "nfs://", "ftp://", "dav://", "news:", "telnet://", "imap:", "rtsp://", "urn:",
        "pop:", "sip:", "sips:", "tftp:", "btspp://", "btl2cap://", "btgoep://",
        "tcpobex://", "irdaobex://", "file://", "urn:epc:id:", "urn:epc:tag:",
        "urn:epc:pat:", "urn:epc:raw:", "urn:epc:", "urn:nfc:"
    };

    /**
     * Whether the page has asked to be scanning.
     *
     * <p>Kept separate from whether reader mode is actually enabled, because the two legitimately
     * disagree: Android tears reader mode down whenever the activity is not resumed. This field is
     * the intent, and the lifecycle hooks below reconcile the hardware to it.
     */
    private boolean scanRequested = false;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        NfcAdapter adapter = adapter();
        JSObject result = new JSObject();
        // Reported separately because they need different words to the operator: absent hardware
        // is permanent, disabled hardware is one tap away in Settings.
        result.put("available", adapter != null);
        result.put("enabled", adapter != null && adapter.isEnabled());
        call.resolve(result);
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        NfcAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("این دستگاه NFC ندارد.");
            return;
        }
        if (!adapter.isEnabled()) {
            // Rejected rather than reported as a tag error: this is the one the operator can fix,
            // and the message has to say so.
            call.reject("NFC خاموش است. لطفاً آن را از تنظیمات روشن کنید.");
            return;
        }
        scanRequested = true;
        enableReader();
        call.resolve();
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        scanRequested = false;
        disableReader();
        call.resolve();
    }

    /**
     * Android only permits reader mode on a resumed activity, so a scan running when the screen
     * locks must be re-established rather than assumed still live. Without these two the reader
     * comes back dead after any interruption — a call, a notification, the screen timing out —
     * and looks to the operator like a tag that will not read.
     */
    @Override
    protected void handleOnResume() {
        if (scanRequested) enableReader();
    }

    @Override
    protected void handleOnPause() {
        disableReader();
    }

    private NfcAdapter adapter() {
        Activity activity = getActivity();
        return activity == null ? null : NfcAdapter.getDefaultAdapter(activity);
    }

    private void enableReader() {
        final Activity activity = getActivity();
        final NfcAdapter adapter = adapter();
        if (activity == null || adapter == null) return;

        final int flags = NfcAdapter.FLAG_READER_NFC_A
            | NfcAdapter.FLAG_READER_NFC_B
            | NfcAdapter.FLAG_READER_NFC_F
            | NfcAdapter.FLAG_READER_NFC_V
            | NfcAdapter.FLAG_READER_NFC_BARCODE;

        final Bundle extras = new Bundle();
        // Give a slow or badly-aligned tag time to answer before Android calls it absent. The
        // default is aggressive for a gloved hand holding a tablet against a pipe.
        extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 1000);

        activity.runOnUiThread(() -> {
            try {
                adapter.enableReaderMode(activity, this::onTagDiscovered, flags, extras);
            } catch (Exception e) {
                emitError("خطا در راه‌اندازی NFC: " + message(e));
            }
        });
    }

    private void disableReader() {
        final Activity activity = getActivity();
        final NfcAdapter adapter = adapter();
        if (activity == null || adapter == null) return;
        activity.runOnUiThread(() -> {
            try {
                adapter.disableReaderMode(activity);
            } catch (Exception ignored) {
                // Disabling a reader that is already gone is not a failure worth telling anyone
                // about, and this runs on the way out of a screen.
            }
        });
    }

    /**
     * Called on Android's NFC thread, once per tag.
     *
     * <p>Everything here is wrapped: a tag that cannot be read is a bad read, not a broken app. An
     * exception escaping this callback would take reader mode down with it and leave the operator
     * tapping a dead reader with no way back short of restarting.
     */
    private void onTagDiscovered(Tag tag) {
        try {
            JSObject payload = new JSObject();
            payload.put("serialNumber", hex(tag.getId()));
            payload.put("records", records(tag));
            notifyListeners("nfcTag", payload);
        } catch (Exception e) {
            emitError("خطا در خواندن تگ NFC: " + message(e));
        }
    }

    /**
     * The tag's NDEF records, or an empty array.
     *
     * <p>Empty is a real answer, not a failure: a blank or non-NDEF tag still has a serial, and
     * the web side decides what to do with a tag that carries no message.
     */
    private JSArray records(Tag tag) {
        JSArray records = new JSArray();
        Ndef ndef = Ndef.get(tag);
        if (ndef == null) return records;

        // The cached message is the one read during discovery. Reading again would mean connecting
        // to a tag that may already have been moved away, which fails far more often than it
        // helps.
        NdefMessage message = ndef.getCachedNdefMessage();
        if (message == null) return records;

        for (NdefRecord record : message.getRecords()) {
            records.put(describe(record));
        }
        return records;
    }

    /** One record, in Web NFC's vocabulary, with its payload normalised the same way. */
    private JSObject describe(NdefRecord record) {
        JSObject out = new JSObject();
        byte[] type = record.getType();
        byte[] payload = record.getPayload();

        switch (record.getTnf()) {
            case NdefRecord.TNF_WELL_KNOWN:
                if (Arrays.equals(type, NdefRecord.RTD_TEXT)) {
                    out.put("recordType", "text");
                    payload = utf8(decodeText(payload));
                } else if (Arrays.equals(type, NdefRecord.RTD_URI)) {
                    out.put("recordType", "url");
                    payload = utf8(decodeUri(payload));
                } else if (Arrays.equals(type, NdefRecord.RTD_SMART_POSTER)) {
                    out.put("recordType", "smart-poster");
                } else {
                    out.put("recordType", ascii(type));
                }
                break;
            case NdefRecord.TNF_MIME_MEDIA:
                out.put("recordType", "mime");
                out.put("mediaType", ascii(type));
                break;
            case NdefRecord.TNF_ABSOLUTE_URI:
                out.put("recordType", "absolute-url");
                // The URI belongs in the type field for this TNF, though tags in the wild put it
                // in the payload often enough that both have to be tried.
                if (payload.length == 0 && type.length > 0) payload = type;
                break;
            case NdefRecord.TNF_EXTERNAL_TYPE:
                out.put("recordType", ascii(type));
                break;
            case NdefRecord.TNF_EMPTY:
                out.put("recordType", "empty");
                break;
            default:
                out.put("recordType", "unknown");
                break;
        }

        if (payload.length > 0) {
            // NO_WRAP: the default inserts a newline every 76 characters, which atob() rejects.
            out.put("payload", Base64.encodeToString(payload, Base64.NO_WRAP));
        }
        return out;
    }

    /**
     * An NDEF text payload, stripped of its status byte and language code the way Web NFC strips
     * them, and returned as text so the caller can re-encode it as UTF-8.
     *
     * <p>A malformed header is passed through whole rather than dropped: a tag written by
     * something that got the length wrong still carries an id, and a partly-wrong string gives the
     * shared decoder something to work with. Returning nothing would lose the tag entirely.
     */
    private String decodeText(byte[] payload) {
        if (payload.length == 0) return "";
        int status = payload[0] & 0xFF;
        int languageLength = status & 0x3F;
        boolean utf16 = (status & 0x80) != 0;
        int offset = 1 + languageLength;
        if (offset > payload.length) return new String(payload, StandardCharsets.UTF_8);
        return new String(
            payload, offset, payload.length - offset,
            utf16 ? StandardCharsets.UTF_16 : StandardCharsets.UTF_8
        );
    }

    /** An NDEF URI payload with its prefix byte expanded, per RTD-URI. */
    private String decodeUri(byte[] payload) {
        if (payload.length == 0) return "";
        int index = payload[0] & 0xFF;
        String prefix = index < URI_PREFIXES.length ? URI_PREFIXES[index] : "";
        return prefix + new String(payload, 1, payload.length - 1, StandardCharsets.UTF_8);
    }

    private void emitError(String text) {
        JSObject payload = new JSObject();
        payload.put("message", text);
        notifyListeners("nfcError", payload);
    }

    private static String message(Exception e) {
        String text = e.getMessage();
        return text == null ? e.getClass().getSimpleName() : text;
    }

    private static byte[] utf8(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    /** Record types and media types are ASCII by specification. */
    private static String ascii(byte[] value) {
        return new String(value, StandardCharsets.US_ASCII);
    }

    /** The hardware serial, formatted the way Web NFC formats it. */
    private static String hex(byte[] id) {
        if (id == null || id.length == 0) return "";
        StringBuilder out = new StringBuilder(id.length * 3);
        for (byte b : id) {
            if (out.length() > 0) out.append(':');
            out.append(String.format(Locale.US, "%02x", b));
        }
        return out.toString();
    }
}
