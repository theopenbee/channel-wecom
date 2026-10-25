import { defineChannel } from "@theopenbee/channel-sdk";

import { createWeComChannel } from "../dist/wecom.js";

defineChannel(createWeComChannel(JSON.parse(process.argv[2] ?? "{}")));
