package io.conclave.agentsgo;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.google.zxing.client.android.Intents;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Map;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "AgentsGo")
public class AgentsGoPlugin extends Plugin {
    private static final String KEY_ALIAS = "agents-go.credentials.v1";
    private static final String CREDENTIALS = "agents-go.credentials";
    private static final String PREFERENCES = "agents-go.preferences";
    private volatile boolean active = true;
    private volatile boolean scanning = false;

    @PluginMethod
    public void initialize(PluginCall call) {
        JSObject preferences = new JSObject();
        for (Map.Entry<String, ?> entry : store(PREFERENCES).getAll().entrySet()) {
            if (entry.getValue() instanceof String) preferences.put(entry.getKey(), entry.getValue());
        }
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "Android" : Build.MODEL.trim();
        String name = model.toLowerCase(Locale.ROOT).startsWith(manufacturer.toLowerCase(Locale.ROOT)) ? model : manufacturer + " " + model;
        JSObject result = new JSObject();
        result.put("preferences", preferences);
        result.put("deviceName", name.trim().substring(0, Math.min(name.trim().length(), 80)));
        result.put("active", active);
        call.resolve(result);
    }

    @PluginMethod
    public void readCredential(PluginCall call) {
        try {
            String key = requireKey(call);
            String saved = store(CREDENTIALS).getString(key, null);
            String value = null;
            if (saved != null) {
                JSONObject envelope = new JSONObject(saved);
                if (envelope.getInt("version") != 1) throw new IllegalStateException("Unsupported credential version");
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
                cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
                value = new String(cipher.doFinal(Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)), StandardCharsets.UTF_8);
            }
            JSObject result = new JSObject();
            result.put("value", value == null ? JSONObject.NULL : value);
            call.resolve(result);
        } catch (Exception error) { call.reject("无法读取此设备保存的连接凭据", "CREDENTIAL_READ_FAILED", error); }
    }

    @PluginMethod
    public void writeCredential(PluginCall call) {
        try {
            String key = requireKey(call);
            String value = call.getString("value");
            SharedPreferences.Editor editor = store(CREDENTIALS).edit();
            if (value == null) editor.remove(key);
            else {
                if (value.length() > 2_000_000) throw new IllegalArgumentException("Credential is too large");
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, secretKey());
                cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
                JSONObject envelope = new JSONObject();
                envelope.put("version", 1);
                envelope.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
                envelope.put("ciphertext", Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
                editor.putString(key, envelope.toString());
            }
            if (!editor.commit()) throw new IllegalStateException("Credential commit failed");
            call.resolve();
        } catch (Exception error) { call.reject("无法保存此设备的连接凭据", "CREDENTIAL_WRITE_FAILED", error); }
    }

    @PluginMethod
    public void writePreference(PluginCall call) {
        try {
            String key = requireKey(call);
            String value = call.getString("value");
            if (value != null && value.length() > 2_000_000) throw new IllegalArgumentException("Preference is too large");
            SharedPreferences.Editor editor = store(PREFERENCES).edit();
            if (value == null) editor.remove(key); else editor.putString(key, value);
            if (!editor.commit()) throw new IllegalStateException("Preference commit failed");
            call.resolve();
        } catch (Exception error) { call.reject("无法保存设置", "PREFERENCE_WRITE_FAILED", error); }
    }

    @PluginMethod
    public void scanInvitation(PluginCall call) {
        if (scanning) { call.reject("扫码已打开", "SCAN_IN_PROGRESS"); return; }
        scanning = true;
        ScanOptions options = new ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("对准电脑上的连接二维码")
            .setBeepEnabled(false)
            .setBarcodeImageEnabled(false)
            .setOrientationLocked(false);
        try { startActivityForResult(call, options.createScanIntent(getContext()), "scanResult"); }
        catch (Exception error) { scanning = false; call.reject("无法打开相机", "SCAN_FAILED", error); }
    }

    @ActivityCallback
    private void scanResult(PluginCall call, ActivityResult result) {
        scanning = false;
        if (call == null) return;
        if (result.getData() != null && result.getData().getBooleanExtra(Intents.Scan.MISSING_CAMERA_PERMISSION, false)) {
            call.reject("请在系统设置中允许 agents-go 使用相机后重试", "CAMERA_PERMISSION_DENIED");
            return;
        }
        ScanIntentResult scanned = ScanIntentResult.parseActivityResult(result.getResultCode(), result.getData());
        JSObject response = new JSObject();
        response.put("value", scanned.getContents() == null ? JSONObject.NULL : scanned.getContents());
        call.resolve(response);
    }

    @Override
    protected void handleOnResume() { reportActivity(true); }

    @Override
    protected void handleOnPause() { reportActivity(false); }

    private void reportActivity(boolean next) {
        active = next;
        JSObject event = new JSObject();
        event.put("active", active);
        notifyListeners("activity", event);
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        // The bridge is only available to the bundled app, never to scanned or chat URLs.
        if (BundledNavigation.allows(url.getScheme(), url.getHost(), url.getPort(), url.getPath())) return false;
        // Only explicit HTTPS links may leave the app through Capacitor's external browser path.
        if ("https".equals(url.getScheme()) && url.getHost() != null && !"localhost".equals(url.getHost())) return null;
        return true;
    }

    private SharedPreferences store(String name) { return getContext().getSharedPreferences(name, Context.MODE_PRIVATE); }

    private String requireKey(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty() || key.length() > 512) throw new IllegalArgumentException("Invalid storage key");
        return key;
    }

    private synchronized SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }
}
