package fr.rc4st.tempo;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.widget.RemoteViews;
import java.io.File;

/**
 * Widget d'écran d'accueil : juste la constellation (dessinée par Tempo avec les étoiles de la semaine),
 * sur un fond clair ou sombre dont la transparence se règle dans Tempo. Un appui = Tempo t'écoute.
 */
public class TempoWidget extends AppWidgetProvider {

    static final String PNG = "widget.png";

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) m.updateAppWidget(id, views(c));
    }

    static RemoteViews views(Context c) {
        SharedPreferences p = c.getSharedPreferences(TempoNativePlugin.PREFS, Context.MODE_PRIVATE);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.tempo_widget);

        // fond : clair / sombre, opacité 0–100 %
        int bg = Math.max(0, Math.min(100, p.getInt("w_bg", 0)));
        v.setImageViewResource(R.id.w_bg, "sombre".equals(p.getString("w_tone", "clair")) ? R.drawable.widget_bg_dark : R.drawable.widget_bg);
        v.setInt(R.id.w_bg, "setImageAlpha", Math.round(bg * 2.55f));

        // constellation : image envoyée par Tempo, sinon celle d'origine
        File f = new File(c.getFilesDir(), PNG);
        Bitmap bmp = f.exists() ? BitmapFactory.decodeFile(f.getAbsolutePath()) : null;
        if (bmp != null) v.setImageViewBitmap(R.id.w_img, bmp);
        else v.setImageViewResource(R.id.w_img, R.drawable.widget_constellation);
        int img = Math.max(20, Math.min(100, p.getInt("w_img", 100)));
        v.setInt(R.id.w_img, "setImageAlpha", Math.round(img * 2.55f));

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
