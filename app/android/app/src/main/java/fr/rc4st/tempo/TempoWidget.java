package fr.rc4st.tempo;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.widget.RemoteViews;

/** Widget d'écran d'accueil : la constellation + ce qui t'attend. Un appui = Tempo t'écoute. */
public class TempoWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) m.updateAppWidget(id, views(c));
    }

    static RemoteViews views(Context c) {
        SharedPreferences p = c.getSharedPreferences(TempoNativePlugin.PREFS, Context.MODE_PRIVATE);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.tempo_widget);
        v.setTextViewText(R.id.w_big, p.getString("w_big", "Tempo"));
        v.setTextViewText(R.id.w_small, p.getString("w_small", "touche pour parler"));
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("tempo://ecoute"), c, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(c, 7, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        v.setOnClickPendingIntent(R.id.w_root, pi);
        return v;
    }

    static void refresh(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, TempoWidget.class));
        for (int id : ids) m.updateAppWidget(id, views(c));
    }
}
