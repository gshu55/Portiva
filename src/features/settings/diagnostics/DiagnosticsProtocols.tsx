import { ProtocolMatrix } from "../../connections/ProtocolMatrix";
import type { ProtocolDescriptor } from "../../../shared/types";

interface DiagnosticsProtocolsProps {
  protocols: ProtocolDescriptor[];
}

export function DiagnosticsProtocols({ protocols }: DiagnosticsProtocolsProps) {
  return (
    <section className="diagnostics-panel">
      <ProtocolMatrix protocols={protocols} />
    </section>
  );
}
