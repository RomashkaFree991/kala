package fun.skkapap.kala;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.widget.RemoteViews;

import org.json.JSONObject;

/** Home-screen widget: quick task / voice task + status of AI and bots. */
public class KalaWidget extends AppWidgetProvider {
    @Override public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        String status = c.getSharedPreferences("kala", Context.MODE_PRIVATE).getString("widget_status", "Нажмите, чтобы дать задачу");
        for (int id : ids) m.updateAppWidget(id, views(c, status));
        NotifyService.start(c);
    }

    static RemoteViews views(Context c, String status) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget);
        v.setTextViewText(R.id.w_status, status);
        v.setOnClickPendingIntent(R.id.w_task, NotifyService.openApp(c, null, 2, false));
        v.setOnClickPendingIntent(R.id.w_voice, NotifyService.openApp(c, null, 3, true));
        return v;
    }

    static void updateAll(Context c, JSONObject j) {
        int running = j.optInt("running"), bots = j.optInt("bots"), up = j.optInt("botsUp");
        String s = (running > 0 ? "ИИ работает: " + running : "ИИ свободен") + (bots > 0 ? " · боты " + up + "/" + bots : "");
        c.getSharedPreferences("kala", Context.MODE_PRIVATE).edit().putString("widget_status", s).apply();
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, KalaWidget.class));
        for (int id : ids) m.updateAppWidget(id, views(c, s));
    }
}
