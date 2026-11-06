package io.conclave.agentsgo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AgentsGoPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
