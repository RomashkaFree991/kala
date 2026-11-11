package fun.skkapap.kala;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Keeps a long-poll to the user's Kala server and shows notifications while the app is in background. */
public class NotifyService extends Service {
    static final String CH_SVC = "kala_service", CH_MSG = "kala_messages";
    private volatile boolean running;
    private Thread worker;

    static void start(Context c) {
        SharedPreferences p = c.getSharedPreferences("kala", MODE_PRIVATE);
        if (!p.getBoolean("bg", false) || p.getString("token", "").isEmpty()) return;
        Intent i = new Intent(c, NotifyService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }
    static void stop(Context c) { c.stopService(new Intent(c, NotifyService.class)); }

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel s = new NotificationChannel(CH_SVC, "Подключение к серверу", NotificationManager.IMPORTANCE_MIN);
        s.setShowBadge(false);
        nm.createNotificationChannel(s);
        NotificationChannel m = new NotificationChannel(CH_MSG, "Сообщения ИИ", NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(m);
    }

    static PendingIntent openApp(Context c, String chatId, int req, boolean voice) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (chatId != null) i.putExtra("chat", chatId);
        if (voice) i.putExtra("voice", true);
        return PendingIntent.getActivity(c, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void show(Context c, String title, String body, String chatId, int id) {
        channels(c);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CH_MSG) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_notify).setContentTitle(title).setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body)).setAutoCancel(true)
            .setContentIntent(openApp(c, chatId, id, false));
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        try { ((NotificationManager) c.getSystemService(NOTIFICATION_SERVICE)).notify(id, b.build()); } catch (SecurityException ignored) { }
    }

    @Override public void onCreate() {
        super.onCreate();
        channels(this);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH_SVC) : new Notification.Builder(this);
        Notification n = b.setSmallIcon(R.drawable.ic_notify).setContentTitle("Kala на связи")
            .setContentText("Пришлю уведомление, когда ИИ закончит или будет ждать ответа")
            .setContentIntent(openApp(this, null, 1, false)).setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, n);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (worker == null || !worker.isAlive()) {
            running = true;
            worker = new Thread(this::loop);
            worker.start();
        }
        return START_STICKY;
    }

    private String get(String url, String token, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(timeoutMs);
        c.setRequestProperty("Authorization", "Bearer " + token);
        int code = c.getResponseCode();
        if (code == 401) throw new SecurityException("unauthorized");
        InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
        StringBuilder sb = new StringBuilder();
        byte[] buf = new byte[8192]; int n;
        while (in != null && (n = in.read(buf)) > 0) sb.append(new String(buf, 0, n, "UTF-8"));
        c.disconnect();
        if (code >= 400) throw new Exception("HTTP " + code);
        return sb.toString();
    }

    private void loop() {
        SharedPreferences p = getSharedPreferences("kala", MODE_PRIVATE);
        long since = 0, lastWidget = 0;
        int backoff = 2000;
        while (running) {
            String server = p.getString("server", ""), token = p.getString("token", "");
            if (server.isEmpty() || token.isEmpty()) { stopSelf(); return; }
            try {
                if (System.currentTimeMillis() - lastWidget > 5 * 60000) {
                    lastWidget = System.currentTimeMillis();
                    try { KalaWidget.updateAll(this, new JSONObject(get(server + "/api/widget", token, 15000))); } catch (Exception ignored) { }
                }
                JSONObject r = new JSONObject(get(server + "/api/notify/poll?since=" + since + "&wait=50", token, 70000));
                long last = r.optLong("last", since);
                if (since != 0) {
                    JSONArray items = r.optJSONArray("items");
                    for (int i = 0; items != null && i < items.length(); i++) {
                        JSONObject it = items.getJSONObject(i);
                        if (!MainActivity.visible) show(this, it.optString("title"), it.optString("body"), it.optString("chatId", null), (int) (it.optLong("id") % 100000) + 10);
                    }
                    if (items != null && items.length() > 0) lastWidget = 0;
                }
                since = last;
                backoff = 2000;
            } catch (SecurityException e) {
                stopSelf(); return;
            } catch (Exception e) {
                try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
                backoff = Math.min(backoff * 2, 60000);
            }
        }
    }

    @Override public void onDestroy() { running = false; if (worker != null) worker.interrupt(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
