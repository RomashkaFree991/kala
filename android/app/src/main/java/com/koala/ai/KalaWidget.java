package com.koala.ai;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Home-screen widget. Three sizes (small / medium / large), status of the AI, agents, bots,
 * costs and server; panels created by the AI (⇄ to switch); tap the koala for an animation.
 */
public class KalaWidget extends AppWidgetProvider {
    static final String ACTION_KOALA = "com.koala.ai.KOALA", ACTION_NEXT = "com.koala.ai.NEXT_PANEL", ACTION_REFRESH = "com.koala.ai.REFRESH";
    static final String[] PHRASES = {"Привет! 🌿", "Жую эвкалипт…", "Готов к задачам!", "Обними коалу 🤍", "Работаю на сервере", "Скажи — сделаю", "Пора творить ✨"};
    private static final int[] ROW = {R.id.w_row1, R.id.w_row2, R.id.w_row3, R.id.w_row4, R.id.w_row5, R.id.w_row6};
    private static final int[] RI = {R.id.w_ri1, R.id.w_ri2, R.id.w_ri3, R.id.w_ri4, R.id.w_ri5, R.id.w_ri6};
    private static final int[] RE = {R.id.w_re1, R.id.w_re2, R.id.w_re3, R.id.w_re4, R.id.w_re5, R.id.w_re6};
    private static final int[] RL = {R.id.w_rl1, R.id.w_rl2, R.id.w_rl3, R.id.w_rl4, R.id.w_rl5, R.id.w_rl6};
    private static final int[] RV = {R.id.w_rv1, R.id.w_rv2, R.id.w_rv3, R.id.w_rv4, R.id.w_rv5, R.id.w_rv6};

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("kala", Context.MODE_PRIVATE); }

    @Override public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) m.updateAppWidget(id, build(c, id, false));
        NotifyService.start(c);
        fetchAsync(c);
    }

    @Override public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle o) {
        int w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH), h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT);
        String size = w < 150 ? "s" : h >= 140 ? "l" : "m";
        prefs(c).edit().putString("size_" + id, size).apply();
        m.updateAppWidget(id, build(c, id, false));
    }

    @Override public void onReceive(Context c, Intent i) {
        super.onReceive(c, i);
        String a = i.getAction();
        int id = i.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1);
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        if (ACTION_KOALA.equals(a) && id != -1) {
            final PendingResult pr = goAsync();
            m.updateAppWidget(id, build(c, id, true));
            fetchAsync(c);
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try { m.updateAppWidget(id, build(c, id, false)); } finally { pr.finish(); }
            }, 3300);
        } else if (ACTION_NEXT.equals(a) && id != -1) {
            int p = prefs(c).getInt("panel_" + id, 0) + 1;
            prefs(c).edit().putInt("panel_" + id, p).apply();
            m.updateAppWidget(id, build(c, id, false));
        } else if (ACTION_REFRESH.equals(a)) {
            fetchAsync(c);
        }
    }

    private static PendingIntent self(Context c, String action, int id) {
        Intent i = new Intent(c, KalaWidget.class).setAction(action).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        return PendingIntent.getBroadcast(c, action.hashCode() + id * 7, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static RemoteViews build(Context c, int id, boolean party) {
        SharedPreferences p = prefs(c);
        String size = p.getString("size_" + id, "m");
        int layout = "s".equals(size) ? R.layout.widget_small : "l".equals(size) ? R.layout.widget_large : R.layout.widget;
        RemoteViews v = new RemoteViews(c.getPackageName(), layout);
        JSONObject j;
        try { j = new JSONObject(p.getString("widget_json", "{}")); } catch (Exception e) { j = new JSONObject(); }

        // koala (animated on tap)
        v.removeAllViews(R.id.w_kbox);
        v.addView(R.id.w_kbox, new RemoteViews(c.getPackageName(), party ? R.layout.koala_party : R.layout.koala_idle));
        v.setOnClickPendingIntent(R.id.w_kbox, self(c, ACTION_KOALA, id));

        int running = j.optInt("running"), agents = j.optInt("agents"), bots = j.optInt("bots"), up = j.optInt("botsUp");
        JSONArray models = j.optJSONArray("models");
        String model = models != null && models.length() > 0 ? models.optString(0) : "";
        String status = party ? PHRASES[(int) (System.currentTimeMillis() / 1000 % PHRASES.length)]
            : running > 0 ? "Работает: " + (model.isEmpty() ? "ИИ" : model) : "ИИ свободен";
        String line2 = (agents > 0 ? "агентов: " + agents : "агентов нет") + (bots > 0 ? " · боты " + up + "/" + bots : "");

        if ("s".equals(size)) {
            v.setTextViewText(R.id.w_status, party ? "🐨" : running > 0 ? "● работает" : agents > 0 ? agents + " агента" : "Kala");
            v.setOnClickPendingIntent(R.id.w_root, NotifyService.openApp(c, null, 20 + id, false));
            return v;
        }
        v.setTextViewText(R.id.w_status, status);
        v.setOnClickPendingIntent(R.id.w_voice, NotifyService.openApp(c, null, 30 + id, true));
        v.setOnClickPendingIntent(R.id.w_task, NotifyService.openApp(c, null, 40 + id, false));
        v.setOnClickPendingIntent(R.id.w_body, NotifyService.openApp(c, j.optString("lastId", null), 50 + id, false));
        if ("m".equals(size)) {
            v.setTextViewText(R.id.w_line2, line2);
            return v;
        }

        // large: panel 0 = status, then panels created by the AI
        JSONArray panels = j.optJSONArray("panels");
        int count = 1 + (panels == null ? 0 : panels.length());
        int idx = p.getInt("panel_" + id, 0) % count;
        v.setOnClickPendingIntent(R.id.w_swap, self(c, ACTION_NEXT, id));
        v.setViewVisibility(R.id.w_swap, count > 1 ? View.VISIBLE : View.GONE);
        String[][] rows;
        int[] icons = null;
        if (idx == 0) {
            v.setTextViewText(R.id.w_title, "Kala");
            String cost = j.has("cost") ? "$" + j.optDouble("cost") : "—";
            String srv = j.isNull("cpu") || !j.has("cpu") ? "—" : "CPU " + Math.round(j.optDouble("cpu")) + "% · RAM " + Math.round(j.optDouble("mem")) + "%";
            String models2 = models == null || models.length() == 0 ? "—" : join(models);
            rows = new String[][]{
                {"ИИ", running > 0 ? "работает (" + running + ")" : "свободен"},
                {"Модели", models2},
                {"Агенты", String.valueOf(agents)},
                {"Боты", bots > 0 ? up + " из " + bots + " онлайн" : "нет"},
                {"Сегодня потрачено", cost},
                {"Сервер", srv},
            };
            icons = new int[]{R.drawable.ic_w_ai, R.drawable.ic_w_chat, R.drawable.ic_w_agents, R.drawable.ic_w_bot, R.drawable.ic_w_cost, R.drawable.ic_w_cpu};
            if (running > 0 && !party) v.setTextViewText(R.id.w_status, j.optString("status", status));
        } else {
            JSONObject pn = panels.optJSONObject(idx - 1);
            v.setTextViewText(R.id.w_title, pn.optString("title", "Панель"));
            if (!party) v.setTextViewText(R.id.w_status, "панель " + idx + " из " + (count - 1) + " · создана ИИ");
            JSONArray ls = pn.optJSONArray("lines");
            int n = ls == null ? 0 : Math.min(6, ls.length());
            rows = new String[n][];
            String[] emo = new String[n];
            for (int k = 0; k < n; k++) { JSONObject l = ls.optJSONObject(k); rows[k] = new String[]{l.optString("label"), l.optString("value")}; emo[k] = l.optString("icon", "•"); }
            for (int k = 0; k < 6; k++) {
                if (k < n) { v.setViewVisibility(RI[k], View.GONE); v.setViewVisibility(RE[k], View.VISIBLE); v.setTextViewText(RE[k], emo[k].isEmpty() ? "•" : emo[k]); }
            }
        }
        for (int k = 0; k < 6; k++) {
            if (k < rows.length) {
                v.setViewVisibility(ROW[k], View.VISIBLE);
                v.setTextViewText(RL[k], rows[k][0]);
                v.setTextViewText(RV[k], rows[k][1]);
                if (icons != null) { v.setViewVisibility(RE[k], View.GONE); v.setViewVisibility(RI[k], View.VISIBLE); v.setImageViewResource(RI[k], icons[k]); }
            } else v.setViewVisibility(ROW[k], View.GONE);
        }
        return v;
    }

    private static String join(JSONArray a) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < a.length(); i++) { if (i > 0) sb.append(", "); sb.append(a.optString(i)); }
        return sb.toString();
    }

    static void updateAll(Context c, JSONObject j) {
        prefs(c).edit().putString("widget_json", j.toString()).apply();
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, KalaWidget.class));
        for (int id : ids) m.updateAppWidget(id, build(c, id, false));
    }

    static void fetchAsync(Context c) {
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                SharedPreferences p = prefs(app);
                String server = p.getString("server", ""), token = p.getString("token", "");
                if (server.isEmpty() || token.isEmpty()) return;
                HttpURLConnection con = (HttpURLConnection) new URL(server + "/api/widget").openConnection();
                con.setConnectTimeout(10000); con.setReadTimeout(15000);
                con.setRequestProperty("Authorization", "Bearer " + token);
                if (con.getResponseCode() != 200) return;
                InputStream in = con.getInputStream();
                StringBuilder sb = new StringBuilder(); byte[] b = new byte[8192]; int n;
                while ((n = in.read(b)) > 0) sb.append(new String(b, 0, n, "UTF-8"));
                updateAll(app, new JSONObject(sb.toString()));
            } catch (Exception ignored) { }
        }).start();
    }
}
