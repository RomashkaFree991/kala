package com.koala.ai;

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
    private static final int REQ_FILE = 1, REQ_PHOTO = 2, REQ_PERM = 3, REQ_AUDIO = 4, REQ_NOTIF = 5;
    static volatile boolean visible = false;
    private android.webkit.PermissionRequest pendingPerm;

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
            public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel();
                view.loadUrl("file:///android_asset/setup.html?error=" + Uri.encode("Ошибка SSL-сертификата сервера (код " + error.getPrimaryError() + "). Сертификат ещё не выдан или неверный. Попробуйте адрес с http:// или запустите на сервере doctor.sh."));
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest req, android.webkit.WebResourceResponse resp) {
                if (req.isForMainFrame() && resp.getStatusCode() >= 500) {
                    view.loadUrl("file:///android_asset/setup.html?error=" + Uri.encode("Сервер ответил ошибкой " + resp.getStatusCode() + " — Kala на сервере не запущена (nginx не достучался). Выполните на сервере: sudo bash server/doctor.sh"));
                }
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
            public void onPermissionRequest(android.webkit.PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean audio = false;
                    for (String r : request.getResources()) if (android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                    if (!audio) { request.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        pendingPerm = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
                    }
                });
            }

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

    private void loadStart() { loadStart(getIntent()); }
    private void loadStart(Intent intent) {
        String server = getServer();
        if (server == null || server.isEmpty()) { web.loadUrl("file:///android_asset/setup.html"); return; }
        String q = "";
        if (intent != null && intent.getStringExtra("chat") != null) q = "?chat=" + Uri.encode(intent.getStringExtra("chat"));
        else if (intent != null && intent.getBooleanExtra("voice", false)) q = "?voice=1";
        web.loadUrl(server + "/" + q);
    }

    @Override protected void onResume() { super.onResume(); visible = true; KalaWidget.fetchAsync(this); }
    @Override protected void onPause() { super.onPause(); visible = false; }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_AUDIO && pendingPerm != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) pendingPerm.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingPerm.deny();
            pendingPerm = null;
        }
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
        } else if (intent != null && (intent.getStringExtra("chat") != null || intent.getBooleanExtra("voice", false))) {
            loadStart(intent);
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

        /** Checks <url>/api/health in background, result via window.__kalaCb(cbId, json). */
        @JavascriptInterface public void checkServer(String cbId, String url) {
            new Thread(() -> {
                JSONObject r = new JSONObject();
                java.net.HttpURLConnection c = null;
                try {
                    c = (java.net.HttpURLConnection) new java.net.URL(url + "/api/health").openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(10000);
                    c.setInstanceFollowRedirects(true);
                    int code = c.getResponseCode();
                    InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
                    StringBuilder sb = new StringBuilder();
                    if (in != null) {
                        byte[] b = new byte[4096]; int n;
                        while ((n = in.read(b)) > 0 && sb.length() < 4000) sb.append(new String(b, 0, n, "UTF-8"));
                    }
                    String body = sb.toString();
                    if (code == 200 && body.contains("kala")) r.put("ok", true);
                    else if (code == 502 || code == 504) r.put("error", "nginx работает, но Kala на сервере не запущена (HTTP " + code + "). На сервере: sudo bash server/doctor.sh");
                    else if (code == 200) r.put("error", "По этому адресу открывается другой сайт, а не Kala. Проверьте nginx (doctor.sh).");
                    else r.put("error", "Сервер ответил HTTP " + code);
                } catch (javax.net.ssl.SSLException e) {
                    try { r.put("error", "Ошибка SSL: сертификат не выдан или неверный. Попробуйте http:// вместо https://\n(" + e.getMessage() + ")"); } catch (Exception ignored) { }
                } catch (java.net.UnknownHostException e) {
                    try { r.put("error", "Домен не найден (DNS). Проверьте A-запись домена."); } catch (Exception ignored) { }
                } catch (java.net.ConnectException e) {
                    try { r.put("error", "Сервер не принимает соединения (порт закрыт / nginx не запущен).\n" + e.getMessage()); } catch (Exception ignored) { }
                } catch (java.net.SocketTimeoutException e) {
                    try { r.put("error", "Сервер не отвечает (таймаут). Проверьте файрвол: порты 80 и 443."); } catch (Exception ignored) { }
                } catch (Exception e) {
                    try { r.put("error", e.getClass().getSimpleName() + ": " + e.getMessage()); } catch (Exception ignored) { }
                } finally {
                    if (c != null) c.disconnect();
                }
                callback(cbId, r);
            }).start();
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

        /** Listens on 127.0.0.1:53682 for the OAuth redirect (rclone Google login) and returns its URL. */
        @JavascriptInterface public void catchOAuth(String cbId) {
            startOAuthCatcher(cbId);
        }

        /** Remember the session for the widget (works even with background notifications off). */
        @JavascriptInterface public void setToken(String token) {
            if (token == null || token.isEmpty()) prefs.edit().remove("token").apply();
            else prefs.edit().putString("token", token).apply();
            KalaWidget.fetchAsync(MainActivity.this);
        }

        /** Background notifications service (long-poll to the server). */
        @JavascriptInterface public void setBackground(boolean on, String server, String token) {
            SharedPreferences.Editor e = prefs.edit().putBoolean("bg", on);
            if (token != null && !token.isEmpty()) e.putString("token", token);
            e.apply();
            runOnUiThread(() -> {
                if (on) {
                    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
                    try { NotifyService.start(MainActivity.this); } catch (Exception ignored) { }
                } else NotifyService.stop(MainActivity.this);
            });
        }

        @JavascriptInterface public void notify(String title, String body) {
            NotifyService.show(MainActivity.this, title, body, null, (int) (System.currentTimeMillis() % 100000) + 10);
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

    private java.net.ServerSocket oauthServer;

    private void startOAuthCatcher(String cbId) {
        try { if (oauthServer != null) oauthServer.close(); } catch (Exception ignored) { }
        new Thread(() -> {
            JSONObject res = new JSONObject();
            try (java.net.ServerSocket ss = new java.net.ServerSocket(53682, 5, java.net.InetAddress.getByName("127.0.0.1"))) {
                oauthServer = ss;
                ss.setSoTimeout(15 * 60 * 1000);
                while (true) {
                    try (java.net.Socket sock = ss.accept()) {
                        java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(sock.getInputStream(), "UTF-8"));
                        String line = in.readLine();
                        String target = line != null && line.startsWith("GET ") ? line.split(" ")[1] : "/";
                        boolean ok = target.contains("code=") || target.contains("error=");
                        String html = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                            + "<body style='font-family:sans-serif;background:#0a0a0a;color:#f5f5f5;display:flex;align-items:center;justify-content:center;height:90vh;text-align:center'>"
                            + "<div><h2>" + (ok ? "✓ Готово" : "Kala") + "</h2><p>Вернитесь в приложение Kala</p><p><a style='color:#fff' href='kala://connected'>Открыть Kala</a></p></div>"
                            + "<script>setTimeout(function(){location.href='kala://connected'},500)</script></body>";
                        byte[] body = html.getBytes("UTF-8");
                        java.io.OutputStream out = sock.getOutputStream();
                        out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
                        out.write(body);
                        out.flush();
                        if (ok) {
                            res.put("url", "http://127.0.0.1:53682" + target);
                            break;
                        }
                    }
                }
            } catch (java.net.SocketTimeoutException e) {
                try { res.put("error", "Время входа истекло"); } catch (Exception ignored) { }
            } catch (Exception e) {
                if (oauthServer == null || !oauthServer.isClosed()) {
                    try { res.put("error", "Не удалось принять ответ Google: " + e.getMessage()); } catch (Exception ignored) { }
                }
            }
            oauthServer = null;
            if (res.has("url")) {
                runOnUiThread(() -> {
                    Intent i = new Intent(this, MainActivity.class);
                    i.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    startActivity(i);
                });
            }
            if (res.length() > 0) callback(cbId, res);
        }).start();
    }

    private static void deleteRec(File f) {
        File[] ch = f.listFiles();
        if (ch != null) for (File c : ch) deleteRec(c);
        f.delete();
    }
}
