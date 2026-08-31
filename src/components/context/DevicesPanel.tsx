// ===================================================================
// DEVICES PANEL - Honest unavailability state (no mock data, no
// placeholder buttons). Real device integration is not part of the
// current architecture; this panel communicates that without
// pretending functionality exists.
// ===================================================================

import { motion } from 'motion/react';
import { Cpu } from 'lucide-react';
import { Identity } from '../../types.js';
import { PanelEmpty, PanelSection } from './PanelShell.js';

interface DevicesPanelProps {
  identity: Identity;
  authToken?: string;
}

export function DevicesPanel({ identity, authToken }: DevicesPanelProps) {
  // No backend endpoint for connected devices exists in the current
  // architecture. Render an honest empty state that does not list
  // fake devices or "Coming soon" controls.
  return (
    <div>
      <PanelSection title="Connected devices">
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <PanelEmpty
            title="Device integration not available"
            description="Madhurita doesn't currently connect to phones, smart home hubs, or IoT devices. This capability isn't part of the current build."
            icon={<Cpu className="w-7 h-7 text-white/30 mx-auto" />}
          />
        </motion.div>
      </PanelSection>
    </div>
  );
}
