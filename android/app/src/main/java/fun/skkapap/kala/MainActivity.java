package fun.skkapap.kala;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;

public class MainActivity extends Activity {
    private static final int REQ_FILE = 1, REQ_PHOTO = 2, REQ_PERM = 3;

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;
    private String photoCbId;
    private File photoFile;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("kala", MODE_PRIVATE);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0F1115);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(s.getUserAgentString() + " KalaApp/1.0");
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new Bridge(), "KalaAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String server = getServer();
                if ("kala".equals(u.getScheme())) return true;
                if (server != null && u.toString().startsWith(server)) return false;
                if ("file".equals(u.getScheme())) return false;
                openExternal(u.toString());
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    view.loadUrl("file:///android_asset/setup.html?error=" + Uri.encode(String.valueOf(err.getDescription())));
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "Выберите файлы"), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        // allow loading the setup page from assets
        web.getSettings().setAllowFileAccess(true);
        loadStart();
    }

    private String getServer() { return prefs.getString("server", null); }

    private void loadStart() {
        String server = getServer();
        if (server == null || server.isEmpty()) web.loadUrl("file:///android_asset/setup.html");
        else web.loadUrl(server + "/");
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "Не удалось открыть ссылку", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // came back from browser login (kala://connected) — the page refreshes via websocket
        if (intent != null && intent.getData() != null && "kala".equals(intent.getData().getScheme())) {
            web.evaluateJavascript("window.dispatchEvent(new Event('kala-connected'))", null);
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.__kalaBack && window.__kalaBack()) ? 1 : 0", value -> {
            if ("1".equals(value)) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    private void callback(String id, JSONObject obj) {
        final String js = "window.__kalaCb(" + JSONObject.quote(id) + "," + JSONObject.quote(obj.toString()) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private static JSONObject err(String msg) {
        JSONObject o = new JSONObject();
        try { o.put("error", msg); } catch (Exception ignored) { }
        return o;
    }

    private boolean hasStorage() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestStorage() {
        if (hasStorage()) {
            Toast.makeText(this, "Доступ к памяти уже выдан ✓", Toast.LENGTH_SHORT).show();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())));
            } catch (Exception e) {
                startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
            }
        } else {
            requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_PERM);
        }
    }

    // ---------------- camera ----------------
    private void startPhoto(String cbId, String camera) {
        if (photoCbId != null) callback(photoCbId, err("Отменено новым запросом"));
        photoCbId = cbId;
        try {
            File dir = new File(getCacheDir(), "photos");
            dir.mkdirs();
            photoFile = new File(dir, "p_" + System.currentTimeMillis() + ".jpg");
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".files", photoFile);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if ("front".equals(camera)) {
                i.putExtra("android.intent.extras.CAMERA_FACING", 1);
                i.putExtra("android.intent.extras.LENS_FACING_FRONT", 1);
                i.putExtra("android.intent.extra.USE_FRONT_CAMERA", true);
            }
            startActivityForResult(i, REQ_PHOTO);
        } catch (Exception e) {
            callback(cbId, err("Камера недоступна: " + e.getMessage()));
            photoCbId = null;
        }
    }

    private void finishPhoto(boolean ok) {
        final String id = photoCbId;
        final File f = photoFile;
        photoCbId = null;
        if (id == null) return;
        if (!ok || f == null || !f.exists() || f.length() == 0) {
            callback(id, err("Фото не сделано (отменено)"));
            return;
        }
        new Thread(() -> {
            try {
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(f.getAbsolutePath(), o);
                int max = Math.max(o.outWidth, o.outHeight), sample = 1;
                while (max / (sample * 2) >= 1600) sample *= 2;
                o = new BitmapFactory.Options();
                o.inSampleSize = sample;
                Bitmap bmp = BitmapFactory.decodeFile(f.getAbsolutePath(), o);
                float scale = 1600f / Math.max(bmp.getWidth(), bmp.getHeight());
                Matrix m = new Matrix();
                if (scale < 1f) m.postScale(scale, scale);
                int rot = new ExifInterface(f.getAbsolutePath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
                if (rot == ExifInterface.ORIENTATION_ROTATE_90) m.postRotate(90);
                else if (rot == ExifInterface.ORIENTATION_ROTATE_180) m.postRotate(180);
                else if (rot == ExifInterface.ORIENTATION_ROTATE_270) m.postRotate(270);
                Bitmap out = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                out.compress(Bitmap.CompressFormat.JPEG, 85, bos);
                JSONObject r = new JSONObject();
                r.put("base64", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
                r.put("width", out.getWidth());
                r.put("height", out.getHeight());
                f.delete();
                callback(id, r);
            } catch (Throwable t) {
                callback(id, err("Ошибка обработки фото: " + t.getMessage()));
            }
        }).start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PHOTO) {
            finishPhoto(resultCode == RESULT_OK);
        } else if (requestCode == REQ_FILE && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
        }
    }

    // ---------------- JS bridge ----------------
    private class Bridge {
        @JavascriptInterface public boolean isAndroid() { return true; }
        @JavascriptInterface public String getServer() { return MainActivity.this.getServer(); }
        @JavascriptInterface public String defaultServer() { return BuildConfig.DEFAULT_SERVER; }

        @JavascriptInterface public void setServer(String url) {
            prefs.edit().putString("server", url).apply();
            runOnUiThread(() -> web.loadUrl(url + "/"));
        }

        @JavascriptInterface public void changeServer() {
            runOnUiThread(() -> web.loadUrl("file:///android_asset/setup.html"));
        }

        @JavascriptInterface public void openUrl(String url) { runOnUiThread(() -> openExternal(url)); }

        @JavascriptInterface public void download(String url, String name) {
            runOnUiThread(() -> {
                try {
                    DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                    r.setTitle(name);
                    r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    if (name.endsWith(".apk")) r.setMimeType("application/vnd.android.package-archive");
                    ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(r);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Ошибка загрузки: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface public boolean hasStorage() { return MainActivity.this.hasStorage(); }
        @JavascriptInterface public void requestStorage() { runOnUiThread(MainActivity.this::requestStorage); }

        @JavascriptInterface public void takePhoto(String cbId, String camera) {
            runOnUiThread(() -> startPhoto(cbId, camera));
        }

        @JavascriptInterface public String listFiles(String path) {
            try {
                if (!MainActivity.this.hasStorage()) return err(noPerm()).toString();
                File d = new File(path);
                File[] list = d.listFiles();
                if (list == null) return err("Папка не найдена или нет доступа: " + path).toString();
                JSONArray arr = new JSONArray();
                for (File f : list) {
                    JSONObject o = new JSONObject();
                    o.put("name", f.getName());
                    o.put("dir", f.isDirectory());
                    o.put("size", f.length());
                    o.put("mtime", f.lastModified());
                    arr.put(o);
                }
                JSONObject r = new JSONObject();
                r.put("items", arr);
                return r.toString();
            } catch (Exception e) { return err(e.getMessage()).toString(); }
        }

        @JavascriptInterface public String readFile(String path, int maxBytes) {
            try {
                if (!MainActivity.this.hasStorage()) return err(noPerm()).toString();
                File f = new File(path);
                if (!f.isFile()) return err("Файл не найден: " + path).toString();
                if (f.length() > maxBytes) return err("Файл слишком большой (" + f.length() + " байт)").toString();
                byte[] buf = new byte[(int) f.length()];
                try (InputStream in = new FileInputStream(f)) {
                    int off = 0, n;
                    while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
                }
                JSONObject r = new JSONObject();
                r.put("base64", Base64.encodeToString(buf, Base64.NO_WRAP));
                r.put("size", buf.length);
                return r.toString();
            } catch (Throwable e) { return err(String.valueOf(e.getMessage())).toString(); }
        }

        @JavascriptInterface public String writeFile(String path, String b64) {
            try {
                if (!MainActivity.this.hasStorage()) return err(noPerm()).toString();
                File f = new File(path);
                File parent = f.getParentFile();
                if (parent != null) parent.mkdirs();
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(Base64.decode(b64, Base64.DEFAULT));
                }
                JSONObject r = new JSONObject();
                r.put("ok", true);
                return r.toString();
            } catch (Throwable e) { return err(String.valueOf(e.getMessage())).toString(); }
        }

        @JavascriptInterface public String deletePath(String path) {
            try {
                if (!MainActivity.this.hasStorage()) return err(noPerm()).toString();
                File f = new File(path);
                if (!f.exists()) return err("Не найдено: " + path).toString();
                deleteRec(f);
                JSONObject r = new JSONObject();
                r.put("ok", true);
                return r.toString();
            } catch (Exception e) { return err(e.getMessage()).toString(); }
        }

        private String noPerm() {
            return "Нет разрешения Android на файлы. В приложении: меню → «Доступ к памяти телефона».";
        }
    }

    private static void deleteRec(File f) {
        File[] ch = f.listFiles();
        if (ch != null) for (File c : ch) deleteRec(c);
        f.delete();
    }
}
