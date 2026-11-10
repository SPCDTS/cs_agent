import path from "node:path";
import { runWsbExecution, runWsbGuardian } from "./wsb-execution.ts";
import { nativeWsb } from "./wsb-native.ts";

const [role, dir, id] = process.argv.slice(2);
if (!dir || !path.isAbsolute(dir)) throw new Error("wsb_session_path_required");
if (role === "guard") await runWsbGuardian(dir, nativeWsb);
else if (role === "execute" && id) await runWsbExecution(dir, id, nativeWsb);
else throw new Error("wsb_helper_role_required");
