import { defineChannel } from "@theopenbee/channel-sdk";

import { createWeComChannel } from "./wecom.js";

defineChannel(createWeComChannel());
