package com.hnp.mfdcs;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Capacitor auto-registers plugins that arrive as npm packages, by reading their metadata at
     * build time. A plugin living in the app's own source is invisible to that, so it has to be
     * named here — and before {@code super.onCreate}, which is where the bridge is built and the
     * plugin registry is frozen. Registered afterwards, {@code window.Capacitor.Plugins.Nfc} is
     * undefined, {@code isNFCSupported()} answers false, and scanning quietly disappears from the
     * app with no error anywhere.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NfcPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
