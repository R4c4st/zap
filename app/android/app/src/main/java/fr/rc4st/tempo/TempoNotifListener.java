package fr.rc4st.tempo;

import android.app.Notification;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

/**
 * Lit les notifications de Téléphone, Messages et WhatsApp (accès accordé par Raphaël dans
 * Paramètres > Accès aux notifications) et les range dans la boîte d'entrée locale de Tempo.
 * Rien ne quitte le téléphone : Tempo les relève à son ouverture.
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

    static String appOf(String pkg) {
        if (DIALER.contains(pkg)) return "Téléphone";
        if (SMS.contains(pkg)) return "Messages";
        if (WA.contains(pkg)) return "WhatsApp";
        return null;
    }

    private static String s(CharSequence c) {
        return c == null ? "" : c.toString().trim();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            String pkg = sbn.getPackageName();
            String app = appOf(pkg);
            if (app == null) return;
            Notification n = sbn.getNotification();
            if (n == null) return;
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;   // résumé « 3 messages »
            if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0) return;   // appel en cours
            Bundle ex = n.extras;
            if (ex == null) return;
            String title = s(ex.getCharSequence(Notification.EXTRA_TITLE));
            String text = s(ex.getCharSequence(Notification.EXTRA_BIG_TEXT));
            if (text.isEmpty()) text = s(ex.getCharSequence(Notification.EXTRA_TEXT));
            // WhatsApp / Messages groupent les messages : on prend le dernier reçu
            Parcelable[] msgs = ex.getParcelableArray(Notification.EXTRA_MESSAGES);
            if (msgs != null && msgs.length > 0 && msgs[msgs.length - 1] instanceof Bundle) {
                Bundle last = (Bundle) msgs[msgs.length - 1];
                String t = s(last.getCharSequence("text"));
                if (!t.isEmpty()) text = t;
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
