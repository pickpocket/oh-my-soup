/** Internal transitions run at the beginning of every Board write (§1.1, §4.2). */
import { pruneStreams } from "./identity";
import type { WriteTx } from "./store";
import { materializeTurf } from "./turf";

export function materializeBoard(tx: WriteTx): void {
	materializeTurf(tx);
	pruneStreams(tx);
}
