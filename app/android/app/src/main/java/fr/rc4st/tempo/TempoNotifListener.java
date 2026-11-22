package fr.rc4st.tempo;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONObject;

/**
 * Lit les notifications de Téléphone, Messages et WhatsApp, plus celles des applis cochées
 * dans Tempo (Snapchat, Vinted, Amazon, transporteurs…). Accès accordé dans Paramètres > Accès aux notifications.
 * Les notifications sont rangées dans la boîte d'entrée locale de Tempo : rien ne quitte le téléphone ici.
 * Pour les autres applis, seul leur NOM est noté (jamais le contenu), pour pouvoir les proposer dans les réglages.
 */
public class TempoNotifListener extends NotificationListenerService {

    static final Set<String> DIALER = new HashSet<>(Arrays.asList(
        "com.samsung.android.dialer", "com.google.android.dialer", "com.android.dialer",
        "com.android.server.telecom", "com.samsung.android.incallui"
    ));
    static final Set<String> SMS = new HashSet<>(Arrays.asList(
        "com.samsung.android.messaging", "com.google.android.apps.messaging", "com.android.mms",
        "com.android.messaging"
    ));
    static final Set<String> WA = new HashSet<>(Arrays.asList("com.whatsapp", "com.whatsapp.w4b"));
    static final Set<String> SKIP = new HashSet<>(Arrays.asList("android", "com.android.systemui", "fr.rc4st.tempo"));

    static String appOf(String pkg) {
        if (DIALER.contains(pkg)) return "Téléphone";
        if (SMS.contains(pkg)) return "Messages";
        if (WA.contains(pkg)) return "WhatsApp";
        if ("com.snapchat.android".equals(pkg)) return "Snapchat";
        return null;
    }

    static Set<String> watched(Context c) {
        return c.getSharedPreferences(TempoNativePlugin.PREFS, Context.MODE_PRIVATE).getStringSet("watch", new HashSet<>());
    }

    static String labelOf(Context c, String pkg, Bundle ex) {
        PackageManager pm = c.getPackageManager();
        try {
            Object o = ex != null ? ex.get("android.appInfo") : null;
            if (o instanceof ApplicationInfo) {
                CharSequence l = pm.getApplicationLabel((ApplicationInfo) o);
                if (l != null && l.length() > 0) return l.toString();
            }
        } catch (Exception ignored) {}
        try {
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    /** applis qui notifient : seulement le nom du paquet et l'heure, pour les proposer dans Tempo */
    static synchronized void noteSeen(Context c, String pkg) {
        SharedPreferences p = c.getSharedPreferences(TempoNativePlugin.PREFS, Context.MODE_PRIVATE);
        try {
            JSONObject o = new JSONObject(p.getString("seen", "{}"));
            long now = System.currentTimeMillis();
            if (now - o.optLong(pkg, 0) < 3600000) return;   // au plus une écriture par heure et par appli
            o.put(pkg, now);
            while (o.length() > 80) {   // on oublie la plus ancienne
                String old = null; long t = Long.MAX_VALUE;
                for (Iterator<String> it = o.keys(); it.hasNext(); ) { String k = it.next(); long v = o.optLong(k, 0); if (v < t) { t = v; old = k; } }
                if (old == null) break;
                o.remove(old);
            }
            p.edit().putString("seen", o.toString()).apply();
        } catch (Exception ignored) {}
    }

    private static String s(CharSequence c) {
        return c == null ? "" : c.toString().trim();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            String pkg = sbn.getPackageName();
            if (pkg == null || SKIP.contains(pkg)) return;
            Notification n = sbn.getNotification();
            if (n == null) return;
            Bundle ex = n.extras;
            String app = appOf(pkg);
            boolean fixed = app != null && !"Snapchat".equals(app);
            if (!fixed && !watched(getApplicationContext()).contains(pkg)) {
                noteSeen(getApplicationContext(), pkg);
                return;
            }
            if (app == null) app = labelOf(getApplicationContext(), pkg, ex);
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;   // résumé « 3 messages »
            if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0) return;   // appel en cours, téléchargement…
            if (ex == null) return;
            String title = s(ex.getCharSequence(Notification.EXTRA_TITLE));
            String text = s(ex.getCharSequence(Notification.EXTRA_BIG_TEXT));
            if (text.isEmpty()) text = s(ex.getCharSequence(Notification.EXTRA_TEXT));
            // WhatsApp / Messages / Snapchat groupent les messages : on prend le dernier reçu
            Parcelable[] msgs = ex.getParcelableArray(Notification.EXTRA_MESSAGES);
            if (msgs != null && msgs.length > 0 && msgs[msgs.length - 1] instanceof Bundle) {
                Bundle last = (Bundle) msgs[msgs.length - 1];
                String t = s(last.getCharSequence("text"));
                if (!t.isEmpty()) text = t;
                if (title.isEmpty()) title = s(last.getCharSequence("sender"));
            }
            if (title.isEmpty() && text.isEmpty()) return;
            JSONObject ev = new JSONObject();
            ev.put("pkg", pkg);
            ev.put("app", app);
            ev.put("title", title);
            ev.put("text", text.length() > 1500 ? text.substring(0, 1500) : text);
            ev.put("at", sbn.getPostTime());
            TempoNativePlugin.inboxAdd(getApplicationContext(), ev);
        } catch (Exception ignored) {
            // une notification illisible ne doit jamais faire planter l'écoute
        }
    }
}
