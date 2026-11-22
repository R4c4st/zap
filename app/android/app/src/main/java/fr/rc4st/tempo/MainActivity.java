package fr.rc4st.tempo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // le plugin maison doit être enregistré avant que le pont Capacitor ne démarre
        registerPlugin(TempoNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
