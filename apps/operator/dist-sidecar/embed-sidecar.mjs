#!/usr/bin/env node
import{createRequire as __pcr}from'module';import{fileURLToPath as __pftu}from'url';import{dirname as __pdn}from'path';const require=__pcr(import.meta.url);const __filename=__pftu(import.meta.url);const __dirname=__pdn(__filename);const module={exports:{}};const exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../libs/generic/module-singleton/src/index.ts
function slots() {
  const store = globalThis;
  let map = store[SLOTS_KEY];
  if (!map) {
    map = /* @__PURE__ */ new Map();
    store[SLOTS_KEY] = map;
  }
  return map;
}
function pinModuleState(key, init) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("pinModuleState: key must be a non-empty string");
  }
  const map = slots();
  const now = Date.now();
  const existing = map.get(key);
  if (existing) {
    existing.evaluations += 1;
    existing.lastSeenAt = now;
    return existing.value;
  }
  const value = init();
  map.set(key, { value, evaluations: 1, firstSeenAt: now, lastSeenAt: now });
  return value;
}
var SLOTS_KEY;
var init_src = __esm({
  "../../libs/generic/module-singleton/src/index.ts"() {
    "use strict";
    SLOTS_KEY = Symbol.for("@papercusp/module-singleton.slots");
  }
});

// ../../libs/generic/memory/src/config.ts
function memorySchema() {
  return memoryHost().schema ?? "public";
}
function memoryHost() {
  const host = state.host;
  if (!host) {
    throw new Error(
      "@papercusp/memory is not configured \u2014 call configureMemory({ \u2026 }) before using the store (the operator does this in lib/memory/configure.ts)."
    );
  }
  return host;
}
var STATE_KEY, state;
var init_config = __esm({
  "../../libs/generic/memory/src/config.ts"() {
    "use strict";
    init_src();
    STATE_KEY = "@papercusp/memory:host";
    state = pinModuleState(STATE_KEY, () => ({ host: void 0 }));
  }
});

// ../../node_modules/postgres-array/index.js
var require_postgres_array = __commonJS({
  "../../node_modules/postgres-array/index.js"(exports) {
    "use strict";
    exports.parse = function(source, transform) {
      return new ArrayParser(source, transform).parse();
    };
    var ArrayParser = class _ArrayParser {
      constructor(source, transform) {
        this.source = source;
        this.transform = transform || identity;
        this.position = 0;
        this.entries = [];
        this.recorded = [];
        this.dimension = 0;
      }
      isEof() {
        return this.position >= this.source.length;
      }
      nextCharacter() {
        var character = this.source[this.position++];
        if (character === "\\") {
          return {
            value: this.source[this.position++],
            escaped: true
          };
        }
        return {
          value: character,
          escaped: false
        };
      }
      record(character) {
        this.recorded.push(character);
      }
      newEntry(includeEmpty) {
        var entry;
        if (this.recorded.length > 0 || includeEmpty) {
          entry = this.recorded.join("");
          if (entry === "NULL" && !includeEmpty) {
            entry = null;
          }
          if (entry !== null) entry = this.transform(entry);
          this.entries.push(entry);
          this.recorded = [];
        }
      }
      consumeDimensions() {
        if (this.source[0] === "[") {
          while (!this.isEof()) {
            var char = this.nextCharacter();
            if (char.value === "=") break;
          }
        }
      }
      parse(nested) {
        var character, parser, quote;
        this.consumeDimensions();
        while (!this.isEof()) {
          character = this.nextCharacter();
          if (character.value === "{" && !quote) {
            this.dimension++;
            if (this.dimension > 1) {
              parser = new _ArrayParser(this.source.substr(this.position - 1), this.transform);
              this.entries.push(parser.parse(true));
              this.position += parser.position - 2;
            }
          } else if (character.value === "}" && !quote) {
            this.dimension--;
            if (!this.dimension) {
              this.newEntry();
              if (nested) return this.entries;
            }
          } else if (character.value === '"' && !character.escaped) {
            if (quote) this.newEntry(true);
            quote = !quote;
          } else if (character.value === "," && !quote) {
            this.newEntry();
          } else {
            this.record(character.value);
          }
        }
        if (this.dimension !== 0) {
          throw new Error("array dimension not balanced");
        }
        return this.entries;
      }
    };
    function identity(value) {
      return value;
    }
  }
});

// ../../node_modules/pg-types/lib/arrayParser.js
var require_arrayParser = __commonJS({
  "../../node_modules/pg-types/lib/arrayParser.js"(exports, module) {
    var array = require_postgres_array();
    module.exports = {
      create: function(source, transform) {
        return {
          parse: function() {
            return array.parse(source, transform);
          }
        };
      }
    };
  }
});

// ../../node_modules/postgres-date/index.js
var require_postgres_date = __commonJS({
  "../../node_modules/postgres-date/index.js"(exports, module) {
    "use strict";
    var DATE_TIME = /(\d{1,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,})?.*?( BC)?$/;
    var DATE = /^(\d{1,})-(\d{2})-(\d{2})( BC)?$/;
    var TIME_ZONE = /([Z+-])(\d{2})?:?(\d{2})?:?(\d{2})?/;
    var INFINITY = /^-?infinity$/;
    module.exports = function parseDate(isoDate) {
      if (INFINITY.test(isoDate)) {
        return Number(isoDate.replace("i", "I"));
      }
      var matches = DATE_TIME.exec(isoDate);
      if (!matches) {
        return getDate(isoDate) || null;
      }
      var isBC = !!matches[8];
      var year = parseInt(matches[1], 10);
      if (isBC) {
        year = bcYearToNegativeYear(year);
      }
      var month = parseInt(matches[2], 10) - 1;
      var day = matches[3];
      var hour = parseInt(matches[4], 10);
      var minute = parseInt(matches[5], 10);
      var second = parseInt(matches[6], 10);
      var ms = matches[7];
      ms = ms ? 1e3 * parseFloat(ms) : 0;
      var date;
      var offset = timeZoneOffset(isoDate);
      if (offset != null) {
        date = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
        if (is0To99(year)) {
          date.setUTCFullYear(year);
        }
        if (offset !== 0) {
          date.setTime(date.getTime() - offset);
        }
      } else {
        date = new Date(year, month, day, hour, minute, second, ms);
        if (is0To99(year)) {
          date.setFullYear(year);
        }
      }
      return date;
    };
    function getDate(isoDate) {
      var matches = DATE.exec(isoDate);
      if (!matches) {
        return;
      }
      var year = parseInt(matches[1], 10);
      var isBC = !!matches[4];
      if (isBC) {
        year = bcYearToNegativeYear(year);
      }
      var month = parseInt(matches[2], 10) - 1;
      var day = matches[3];
      var date = new Date(year, month, day);
      if (is0To99(year)) {
        date.setFullYear(year);
      }
      return date;
    }
    function timeZoneOffset(isoDate) {
      if (isoDate.endsWith("+00")) {
        return 0;
      }
      var zone = TIME_ZONE.exec(isoDate.split(" ")[1]);
      if (!zone) return;
      var type = zone[1];
      if (type === "Z") {
        return 0;
      }
      var sign = type === "-" ? -1 : 1;
      var offset = parseInt(zone[2], 10) * 3600 + parseInt(zone[3] || 0, 10) * 60 + parseInt(zone[4] || 0, 10);
      return offset * sign * 1e3;
    }
    function bcYearToNegativeYear(year) {
      return -(year - 1);
    }
    function is0To99(num) {
      return num >= 0 && num < 100;
    }
  }
});

// ../../node_modules/xtend/mutable.js
var require_mutable = __commonJS({
  "../../node_modules/xtend/mutable.js"(exports, module) {
    module.exports = extend;
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function extend(target) {
      for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i];
        for (var key in source) {
          if (hasOwnProperty.call(source, key)) {
            target[key] = source[key];
          }
        }
      }
      return target;
    }
  }
});

// ../../node_modules/postgres-interval/index.js
var require_postgres_interval = __commonJS({
  "../../node_modules/postgres-interval/index.js"(exports, module) {
    "use strict";
    var extend = require_mutable();
    module.exports = PostgresInterval;
    function PostgresInterval(raw) {
      if (!(this instanceof PostgresInterval)) {
        return new PostgresInterval(raw);
      }
      extend(this, parse(raw));
    }
    var properties = ["seconds", "minutes", "hours", "days", "months", "years"];
    PostgresInterval.prototype.toPostgres = function() {
      var filtered = properties.filter(this.hasOwnProperty, this);
      if (this.milliseconds && filtered.indexOf("seconds") < 0) {
        filtered.push("seconds");
      }
      if (filtered.length === 0) return "0";
      return filtered.map(function(property) {
        var value = this[property] || 0;
        if (property === "seconds" && this.milliseconds) {
          value = (value + this.milliseconds / 1e3).toFixed(6).replace(/\.?0+$/, "");
        }
        return value + " " + property;
      }, this).join(" ");
    };
    var propertiesISOEquivalent = {
      years: "Y",
      months: "M",
      days: "D",
      hours: "H",
      minutes: "M",
      seconds: "S"
    };
    var dateProperties = ["years", "months", "days"];
    var timeProperties = ["hours", "minutes", "seconds"];
    PostgresInterval.prototype.toISOString = PostgresInterval.prototype.toISO = function() {
      var datePart = dateProperties.map(buildProperty, this).join("");
      var timePart = timeProperties.map(buildProperty, this).join("");
      return "P" + datePart + "T" + timePart;
      function buildProperty(property) {
        var value = this[property] || 0;
        if (property === "seconds" && this.milliseconds) {
          value = (value + this.milliseconds / 1e3).toFixed(6).replace(/0+$/, "");
        }
        return value + propertiesISOEquivalent[property];
      }
    };
    var NUMBER = "([+-]?\\d+)";
    var YEAR = NUMBER + "\\s+years?";
    var MONTH = NUMBER + "\\s+mons?";
    var DAY = NUMBER + "\\s+days?";
    var TIME = "([+-])?([\\d]*):(\\d\\d):(\\d\\d)\\.?(\\d{1,6})?";
    var INTERVAL = new RegExp([YEAR, MONTH, DAY, TIME].map(function(regexString) {
      return "(" + regexString + ")?";
    }).join("\\s*"));
    var positions = {
      years: 2,
      months: 4,
      days: 6,
      hours: 9,
      minutes: 10,
      seconds: 11,
      milliseconds: 12
    };
    var negatives = ["hours", "minutes", "seconds", "milliseconds"];
    function parseMilliseconds(fraction) {
      var microseconds = fraction + "000000".slice(fraction.length);
      return parseInt(microseconds, 10) / 1e3;
    }
    function parse(interval) {
      if (!interval) return {};
      var matches = INTERVAL.exec(interval);
      var isNegative = matches[8] === "-";
      return Object.keys(positions).reduce(function(parsed, property) {
        var position = positions[property];
        var value = matches[position];
        if (!value) return parsed;
        value = property === "milliseconds" ? parseMilliseconds(value) : parseInt(value, 10);
        if (!value) return parsed;
        if (isNegative && ~negatives.indexOf(property)) {
          value *= -1;
        }
        parsed[property] = value;
        return parsed;
      }, {});
    }
  }
});

// ../../node_modules/postgres-bytea/index.js
var require_postgres_bytea = __commonJS({
  "../../node_modules/postgres-bytea/index.js"(exports, module) {
    "use strict";
    var bufferFrom = Buffer.from || Buffer;
    module.exports = function parseBytea(input) {
      if (/^\\x/.test(input)) {
        return bufferFrom(input.substr(2), "hex");
      }
      var output = "";
      var i = 0;
      while (i < input.length) {
        if (input[i] !== "\\") {
          output += input[i];
          ++i;
        } else {
          if (/[0-7]{3}/.test(input.substr(i + 1, 3))) {
            output += String.fromCharCode(parseInt(input.substr(i + 1, 3), 8));
            i += 4;
          } else {
            var backslashes = 1;
            while (i + backslashes < input.length && input[i + backslashes] === "\\") {
              backslashes++;
            }
            for (var k = 0; k < Math.floor(backslashes / 2); ++k) {
              output += "\\";
            }
            i += Math.floor(backslashes / 2) * 2;
          }
        }
      }
      return bufferFrom(output, "binary");
    };
  }
});

// ../../node_modules/pg-types/lib/textParsers.js
var require_textParsers = __commonJS({
  "../../node_modules/pg-types/lib/textParsers.js"(exports, module) {
    var array = require_postgres_array();
    var arrayParser = require_arrayParser();
    var parseDate = require_postgres_date();
    var parseInterval = require_postgres_interval();
    var parseByteA = require_postgres_bytea();
    function allowNull(fn) {
      return function nullAllowed(value) {
        if (value === null) return value;
        return fn(value);
      };
    }
    function parseBool(value) {
      if (value === null) return value;
      return value === "TRUE" || value === "t" || value === "true" || value === "y" || value === "yes" || value === "on" || value === "1";
    }
    function parseBoolArray(value) {
      if (!value) return null;
      return array.parse(value, parseBool);
    }
    function parseBaseTenInt(string) {
      return parseInt(string, 10);
    }
    function parseIntegerArray(value) {
      if (!value) return null;
      return array.parse(value, allowNull(parseBaseTenInt));
    }
    function parseBigIntegerArray(value) {
      if (!value) return null;
      return array.parse(value, allowNull(function(entry) {
        return parseBigInteger(entry).trim();
      }));
    }
    var parsePointArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parsePoint(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseFloatArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseFloat(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseStringArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value);
      return p.parse();
    };
    var parseDateArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseDate(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseIntervalArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseInterval(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseByteAArray = function(value) {
      if (!value) {
        return null;
      }
      return array.parse(value, allowNull(parseByteA));
    };
    var parseInteger = function(value) {
      return parseInt(value, 10);
    };
    var parseBigInteger = function(value) {
      var valStr = String(value);
      if (/^\d+$/.test(valStr)) {
        return valStr;
      }
      return value;
    };
    var parseJsonArray = function(value) {
      if (!value) {
        return null;
      }
      return array.parse(value, allowNull(JSON.parse));
    };
    var parsePoint = function(value) {
      if (value[0] !== "(") {
        return null;
      }
      value = value.substring(1, value.length - 1).split(",");
      return {
        x: parseFloat(value[0]),
        y: parseFloat(value[1])
      };
    };
    var parseCircle = function(value) {
      if (value[0] !== "<" && value[1] !== "(") {
        return null;
      }
      var point = "(";
      var radius = "";
      var pointParsed = false;
      for (var i = 2; i < value.length - 1; i++) {
        if (!pointParsed) {
          point += value[i];
        }
        if (value[i] === ")") {
          pointParsed = true;
          continue;
        } else if (!pointParsed) {
          continue;
        }
        if (value[i] === ",") {
          continue;
        }
        radius += value[i];
      }
      var result = parsePoint(point);
      result.radius = parseFloat(radius);
      return result;
    };
    var init = function(register) {
      register(20, parseBigInteger);
      register(21, parseInteger);
      register(23, parseInteger);
      register(26, parseInteger);
      register(700, parseFloat);
      register(701, parseFloat);
      register(16, parseBool);
      register(1082, parseDate);
      register(1114, parseDate);
      register(1184, parseDate);
      register(600, parsePoint);
      register(651, parseStringArray);
      register(718, parseCircle);
      register(1e3, parseBoolArray);
      register(1001, parseByteAArray);
      register(1005, parseIntegerArray);
      register(1007, parseIntegerArray);
      register(1028, parseIntegerArray);
      register(1016, parseBigIntegerArray);
      register(1017, parsePointArray);
      register(1021, parseFloatArray);
      register(1022, parseFloatArray);
      register(1231, parseFloatArray);
      register(1014, parseStringArray);
      register(1015, parseStringArray);
      register(1008, parseStringArray);
      register(1009, parseStringArray);
      register(1040, parseStringArray);
      register(1041, parseStringArray);
      register(1115, parseDateArray);
      register(1182, parseDateArray);
      register(1185, parseDateArray);
      register(1186, parseInterval);
      register(1187, parseIntervalArray);
      register(17, parseByteA);
      register(114, JSON.parse.bind(JSON));
      register(3802, JSON.parse.bind(JSON));
      register(199, parseJsonArray);
      register(3807, parseJsonArray);
      register(3907, parseStringArray);
      register(2951, parseStringArray);
      register(791, parseStringArray);
      register(1183, parseStringArray);
      register(1270, parseStringArray);
    };
    module.exports = {
      init
    };
  }
});

// ../../node_modules/pg-int8/index.js
var require_pg_int8 = __commonJS({
  "../../node_modules/pg-int8/index.js"(exports, module) {
    "use strict";
    var BASE = 1e6;
    function readInt8(buffer) {
      var high = buffer.readInt32BE(0);
      var low = buffer.readUInt32BE(4);
      var sign = "";
      if (high < 0) {
        high = ~high + (low === 0);
        low = ~low + 1 >>> 0;
        sign = "-";
      }
      var result = "";
      var carry;
      var t;
      var digits;
      var pad;
      var l;
      var i;
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        t = 4294967296 * carry + low;
        digits = "" + t % BASE;
        return sign + digits + result;
      }
    }
    module.exports = readInt8;
  }
});

// ../../node_modules/pg-types/lib/binaryParsers.js
var require_binaryParsers = __commonJS({
  "../../node_modules/pg-types/lib/binaryParsers.js"(exports, module) {
    var parseInt64 = require_pg_int8();
    var parseBits = function(data, bits, offset, invert, callback) {
      offset = offset || 0;
      invert = invert || false;
      callback = callback || function(lastValue, newValue, bits2) {
        return lastValue * Math.pow(2, bits2) + newValue;
      };
      var offsetBytes = offset >> 3;
      var inv = function(value) {
        if (invert) {
          return ~value & 255;
        }
        return value;
      };
      var mask = 255;
      var firstBits = 8 - offset % 8;
      if (bits < firstBits) {
        mask = 255 << 8 - bits & 255;
        firstBits = bits;
      }
      if (offset) {
        mask = mask >> offset % 8;
      }
      var result = 0;
      if (offset % 8 + bits >= 8) {
        result = callback(0, inv(data[offsetBytes]) & mask, firstBits);
      }
      var bytes = bits + offset >> 3;
      for (var i = offsetBytes + 1; i < bytes; i++) {
        result = callback(result, inv(data[i]), 8);
      }
      var lastBits = (bits + offset) % 8;
      if (lastBits > 0) {
        result = callback(result, inv(data[bytes]) >> 8 - lastBits, lastBits);
      }
      return result;
    };
    var parseFloatFromBits = function(data, precisionBits, exponentBits) {
      var bias = Math.pow(2, exponentBits - 1) - 1;
      var sign = parseBits(data, 1);
      var exponent = parseBits(data, exponentBits, 1);
      if (exponent === 0) {
        return 0;
      }
      var precisionBitsCounter = 1;
      var parsePrecisionBits = function(lastValue, newValue, bits) {
        if (lastValue === 0) {
          lastValue = 1;
        }
        for (var i = 1; i <= bits; i++) {
          precisionBitsCounter /= 2;
          if ((newValue & 1 << bits - i) > 0) {
            lastValue += precisionBitsCounter;
          }
        }
        return lastValue;
      };
      var mantissa = parseBits(data, precisionBits, exponentBits + 1, false, parsePrecisionBits);
      if (exponent == Math.pow(2, exponentBits + 1) - 1) {
        if (mantissa === 0) {
          return sign === 0 ? Infinity : -Infinity;
        }
        return NaN;
      }
      return (sign === 0 ? 1 : -1) * Math.pow(2, exponent - bias) * mantissa;
    };
    var parseInt16 = function(value) {
      if (parseBits(value, 1) == 1) {
        return -1 * (parseBits(value, 15, 1, true) + 1);
      }
      return parseBits(value, 15, 1);
    };
    var parseInt32 = function(value) {
      if (parseBits(value, 1) == 1) {
        return -1 * (parseBits(value, 31, 1, true) + 1);
      }
      return parseBits(value, 31, 1);
    };
    var parseFloat32 = function(value) {
      return parseFloatFromBits(value, 23, 8);
    };
    var parseFloat64 = function(value) {
      return parseFloatFromBits(value, 52, 11);
    };
    var parseNumeric = function(value) {
      var sign = parseBits(value, 16, 32);
      if (sign == 49152) {
        return NaN;
      }
      var weight = Math.pow(1e4, parseBits(value, 16, 16));
      var result = 0;
      var digits = [];
      var ndigits = parseBits(value, 16);
      for (var i = 0; i < ndigits; i++) {
        result += parseBits(value, 16, 64 + 16 * i) * weight;
        weight /= 1e4;
      }
      var scale = Math.pow(10, parseBits(value, 16, 48));
      return (sign === 0 ? 1 : -1) * Math.round(result * scale) / scale;
    };
    var parseDate = function(isUTC, value) {
      var sign = parseBits(value, 1);
      var rawValue = parseBits(value, 63, 1);
      var result = new Date((sign === 0 ? 1 : -1) * rawValue / 1e3 + 9466848e5);
      if (!isUTC) {
        result.setTime(result.getTime() + result.getTimezoneOffset() * 6e4);
      }
      result.usec = rawValue % 1e3;
      result.getMicroSeconds = function() {
        return this.usec;
      };
      result.setMicroSeconds = function(value2) {
        this.usec = value2;
      };
      result.getUTCMicroSeconds = function() {
        return this.usec;
      };
      return result;
    };
    var parseArray = function(value) {
      var dim = parseBits(value, 32);
      var flags = parseBits(value, 32, 32);
      var elementType = parseBits(value, 32, 64);
      var offset = 96;
      var dims = [];
      for (var i = 0; i < dim; i++) {
        dims[i] = parseBits(value, 32, offset);
        offset += 32;
        offset += 32;
      }
      var parseElement = function(elementType2) {
        var length = parseBits(value, 32, offset);
        offset += 32;
        if (length == 4294967295) {
          return null;
        }
        var result;
        if (elementType2 == 23 || elementType2 == 20) {
          result = parseBits(value, length * 8, offset);
          offset += length * 8;
          return result;
        } else if (elementType2 == 25) {
          result = value.toString(this.encoding, offset >> 3, (offset += length << 3) >> 3);
          return result;
        } else {
          console.log("ERROR: ElementType not implemented: " + elementType2);
        }
      };
      var parse = function(dimension, elementType2) {
        var array = [];
        var i2;
        if (dimension.length > 1) {
          var count = dimension.shift();
          for (i2 = 0; i2 < count; i2++) {
            array[i2] = parse(dimension, elementType2);
          }
          dimension.unshift(count);
        } else {
          for (i2 = 0; i2 < dimension[0]; i2++) {
            array[i2] = parseElement(elementType2);
          }
        }
        return array;
      };
      return parse(dims, elementType);
    };
    var parseText = function(value) {
      return value.toString("utf8");
    };
    var parseBool = function(value) {
      if (value === null) return null;
      return parseBits(value, 8) > 0;
    };
    var init = function(register) {
      register(20, parseInt64);
      register(21, parseInt16);
      register(23, parseInt32);
      register(26, parseInt32);
      register(1700, parseNumeric);
      register(700, parseFloat32);
      register(701, parseFloat64);
      register(16, parseBool);
      register(1114, parseDate.bind(null, false));
      register(1184, parseDate.bind(null, true));
      register(1e3, parseArray);
      register(1007, parseArray);
      register(1016, parseArray);
      register(1008, parseArray);
      register(1009, parseArray);
      register(25, parseText);
    };
    module.exports = {
      init
    };
  }
});

// ../../node_modules/pg-types/lib/builtins.js
var require_builtins = __commonJS({
  "../../node_modules/pg-types/lib/builtins.js"(exports, module) {
    module.exports = {
      BOOL: 16,
      BYTEA: 17,
      CHAR: 18,
      INT8: 20,
      INT2: 21,
      INT4: 23,
      REGPROC: 24,
      TEXT: 25,
      OID: 26,
      TID: 27,
      XID: 28,
      CID: 29,
      JSON: 114,
      XML: 142,
      PG_NODE_TREE: 194,
      SMGR: 210,
      PATH: 602,
      POLYGON: 604,
      CIDR: 650,
      FLOAT4: 700,
      FLOAT8: 701,
      ABSTIME: 702,
      RELTIME: 703,
      TINTERVAL: 704,
      CIRCLE: 718,
      MACADDR8: 774,
      MONEY: 790,
      MACADDR: 829,
      INET: 869,
      ACLITEM: 1033,
      BPCHAR: 1042,
      VARCHAR: 1043,
      DATE: 1082,
      TIME: 1083,
      TIMESTAMP: 1114,
      TIMESTAMPTZ: 1184,
      INTERVAL: 1186,
      TIMETZ: 1266,
      BIT: 1560,
      VARBIT: 1562,
      NUMERIC: 1700,
      REFCURSOR: 1790,
      REGPROCEDURE: 2202,
      REGOPER: 2203,
      REGOPERATOR: 2204,
      REGCLASS: 2205,
      REGTYPE: 2206,
      UUID: 2950,
      TXID_SNAPSHOT: 2970,
      PG_LSN: 3220,
      PG_NDISTINCT: 3361,
      PG_DEPENDENCIES: 3402,
      TSVECTOR: 3614,
      TSQUERY: 3615,
      GTSVECTOR: 3642,
      REGCONFIG: 3734,
      REGDICTIONARY: 3769,
      JSONB: 3802,
      REGNAMESPACE: 4089,
      REGROLE: 4096
    };
  }
});

// ../../node_modules/pg-types/index.js
var require_pg_types = __commonJS({
  "../../node_modules/pg-types/index.js"(exports) {
    var textParsers = require_textParsers();
    var binaryParsers = require_binaryParsers();
    var arrayParser = require_arrayParser();
    var builtinTypes = require_builtins();
    exports.getTypeParser = getTypeParser;
    exports.setTypeParser = setTypeParser;
    exports.arrayParser = arrayParser;
    exports.builtins = builtinTypes;
    var typeParsers = {
      text: {},
      binary: {}
    };
    function noParse(val) {
      return String(val);
    }
    function getTypeParser(oid, format) {
      format = format || "text";
      if (!typeParsers[format]) {
        return noParse;
      }
      return typeParsers[format][oid] || noParse;
    }
    function setTypeParser(oid, format, parseFn) {
      if (typeof format == "function") {
        parseFn = format;
        format = "text";
      }
      typeParsers[format][oid] = parseFn;
    }
    textParsers.init(function(oid, converter) {
      typeParsers.text[oid] = converter;
    });
    binaryParsers.init(function(oid, converter) {
      typeParsers.binary[oid] = converter;
    });
  }
});

// ../../node_modules/pg/lib/defaults.js
var require_defaults = __commonJS({
  "../../node_modules/pg/lib/defaults.js"(exports, module) {
    "use strict";
    var user;
    try {
      user = process.platform === "win32" ? process.env.USERNAME : process.env.USER;
    } catch {
    }
    module.exports = {
      // database host. defaults to localhost
      host: "localhost",
      // database user's name
      user,
      // name of database to connect
      database: void 0,
      // database user's password
      password: null,
      // a Postgres connection string to be used instead of setting individual connection items
      // NOTE:  Setting this value will cause it to override any other value (such as database or user) defined
      // in the defaults object.
      connectionString: void 0,
      // database port
      port: 5432,
      // number of rows to return at a time from a prepared statement's
      // portal. 0 will return all rows at once
      rows: 0,
      // binary result mode
      binary: false,
      // Connection pool options - see https://github.com/brianc/node-pg-pool
      // number of connections to use in connection pool
      // 0 will disable connection pooling
      max: 10,
      // max milliseconds a client can go unused before it is removed
      // from the pool and destroyed
      idleTimeoutMillis: 3e4,
      client_encoding: "",
      ssl: false,
      application_name: void 0,
      fallback_application_name: void 0,
      options: void 0,
      parseInputDatesAsUTC: false,
      // max milliseconds any query using this connection will execute for before timing out in error.
      // false=unlimited
      statement_timeout: false,
      // Abort any statement that waits longer than the specified duration in milliseconds while attempting to acquire a lock.
      // false=unlimited
      lock_timeout: false,
      // Terminate any session with an open transaction that has been idle for longer than the specified duration in milliseconds
      // false=unlimited
      idle_in_transaction_session_timeout: false,
      // max milliseconds to wait for query to complete (client side)
      query_timeout: false,
      connect_timeout: 0,
      keepalives: 1,
      keepalives_idle: 0
    };
    var pgTypes = require_pg_types();
    var parseBigInteger = pgTypes.getTypeParser(20, "text");
    var parseBigIntegerArray = pgTypes.getTypeParser(1016, "text");
    module.exports.__defineSetter__("parseInt8", function(val) {
      pgTypes.setTypeParser(20, "text", val ? pgTypes.getTypeParser(23, "text") : parseBigInteger);
      pgTypes.setTypeParser(1016, "text", val ? pgTypes.getTypeParser(1007, "text") : parseBigIntegerArray);
    });
  }
});

// ../../node_modules/pg/lib/utils.js
var require_utils = __commonJS({
  "../../node_modules/pg/lib/utils.js"(exports, module) {
    "use strict";
    var defaults2 = require_defaults();
    var util = __require("util");
    var { isDate } = util.types || util;
    function escapeElement(elementRepresentation) {
      const escaped = elementRepresentation.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return '"' + escaped + '"';
    }
    function arrayString(val) {
      let result = "{";
      for (let i = 0; i < val.length; i++) {
        if (i > 0) {
          result = result + ",";
        }
        if (val[i] === null || typeof val[i] === "undefined") {
          result = result + "NULL";
        } else if (Array.isArray(val[i])) {
          result = result + arrayString(val[i]);
        } else if (ArrayBuffer.isView(val[i])) {
          let item = val[i];
          if (!(item instanceof Buffer)) {
            const buf = Buffer.from(item.buffer, item.byteOffset, item.byteLength);
            if (buf.length === item.byteLength) {
              item = buf;
            } else {
              item = buf.slice(item.byteOffset, item.byteOffset + item.byteLength);
            }
          }
          result += "\\\\x" + item.toString("hex");
        } else {
          result += escapeElement(prepareValue(val[i]));
        }
      }
      result = result + "}";
      return result;
    }
    var prepareValue = function(val, seen) {
      if (val == null) {
        return null;
      }
      if (typeof val === "object") {
        if (val instanceof Buffer) {
          return val;
        }
        if (ArrayBuffer.isView(val)) {
          const buf = Buffer.from(val.buffer, val.byteOffset, val.byteLength);
          if (buf.length === val.byteLength) {
            return buf;
          }
          return buf.slice(val.byteOffset, val.byteOffset + val.byteLength);
        }
        if (isDate(val)) {
          if (defaults2.parseInputDatesAsUTC) {
            return dateToStringUTC(val);
          } else {
            return dateToString(val);
          }
        }
        if (Array.isArray(val)) {
          return arrayString(val);
        }
        return prepareObject(val, seen);
      }
      return val.toString();
    };
    function prepareObject(val, seen) {
      if (val && typeof val.toPostgres === "function") {
        seen = seen || [];
        if (seen.indexOf(val) !== -1) {
          throw new Error('circular reference detected while preparing "' + val + '" for query');
        }
        seen.push(val);
        return prepareValue(val.toPostgres(prepareValue), seen);
      }
      return JSON.stringify(val);
    }
    function dateToString(date) {
      let offset = -date.getTimezoneOffset();
      let year = date.getFullYear();
      const isBCYear = year < 1;
      if (isBCYear) year = Math.abs(year) + 1;
      let ret = String(year).padStart(4, "0") + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + "T" + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0") + ":" + String(date.getSeconds()).padStart(2, "0") + "." + String(date.getMilliseconds()).padStart(3, "0");
      if (offset < 0) {
        ret += "-";
        offset *= -1;
      } else {
        ret += "+";
      }
      ret += String(Math.floor(offset / 60)).padStart(2, "0") + ":" + String(offset % 60).padStart(2, "0");
      if (isBCYear) ret += " BC";
      return ret;
    }
    function dateToStringUTC(date) {
      let year = date.getUTCFullYear();
      const isBCYear = year < 1;
      if (isBCYear) year = Math.abs(year) + 1;
      let ret = String(year).padStart(4, "0") + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0") + "T" + String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0") + ":" + String(date.getUTCSeconds()).padStart(2, "0") + "." + String(date.getUTCMilliseconds()).padStart(3, "0");
      ret += "+00:00";
      if (isBCYear) ret += " BC";
      return ret;
    }
    function normalizeQueryConfig(config, values, callback) {
      config = typeof config === "string" ? { text: config } : config;
      if (values) {
        if (typeof values === "function") {
          config.callback = values;
        } else {
          config.values = values;
        }
      }
      if (callback) {
        config.callback = callback;
      }
      return config;
    }
    var escapeIdentifier2 = function(str) {
      return '"' + str.replace(/"/g, '""') + '"';
    };
    var escapeLiteral2 = function(str) {
      let hasBackslash = false;
      let escaped = "'";
      if (str == null) {
        return "''";
      }
      if (typeof str !== "string") {
        return "''";
      }
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === "'") {
          escaped += c + c;
        } else if (c === "\\") {
          escaped += c + c;
          hasBackslash = true;
        } else {
          escaped += c;
        }
      }
      escaped += "'";
      if (hasBackslash === true) {
        escaped = " E" + escaped;
      }
      return escaped;
    };
    module.exports = {
      prepareValue: function prepareValueWrapper(value) {
        return prepareValue(value);
      },
      normalizeQueryConfig,
      escapeIdentifier: escapeIdentifier2,
      escapeLiteral: escapeLiteral2
    };
  }
});

// ../../node_modules/pg/lib/crypto/utils-legacy.js
var require_utils_legacy = __commonJS({
  "../../node_modules/pg/lib/crypto/utils-legacy.js"(exports, module) {
    "use strict";
    var nodeCrypto = __require("crypto");
    function md5(string) {
      return nodeCrypto.createHash("md5").update(string, "utf-8").digest("hex");
    }
    function postgresMd5PasswordHash(user, password, salt) {
      const inner = md5(password + user);
      const outer = md5(Buffer.concat([Buffer.from(inner), salt]));
      return "md5" + outer;
    }
    function sha256(text) {
      return nodeCrypto.createHash("sha256").update(text).digest();
    }
    function hashByName(hashName, text) {
      hashName = hashName.replace(/(\D)-/, "$1");
      return nodeCrypto.createHash(hashName).update(text).digest();
    }
    function hmacSha256(key, msg) {
      return nodeCrypto.createHmac("sha256", key).update(msg).digest();
    }
    async function deriveKey(password, salt, iterations) {
      return nodeCrypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
    }
    module.exports = {
      postgresMd5PasswordHash,
      randomBytes: nodeCrypto.randomBytes,
      deriveKey,
      sha256,
      hashByName,
      hmacSha256,
      md5
    };
  }
});

// ../../node_modules/pg/lib/crypto/utils-webcrypto.js
var require_utils_webcrypto = __commonJS({
  "../../node_modules/pg/lib/crypto/utils-webcrypto.js"(exports, module) {
    var nodeCrypto = __require("crypto");
    module.exports = {
      postgresMd5PasswordHash,
      randomBytes,
      deriveKey,
      sha256,
      hashByName,
      hmacSha256,
      md5
    };
    var webCrypto = nodeCrypto.webcrypto || globalThis.crypto;
    var subtleCrypto = webCrypto.subtle;
    var textEncoder = new TextEncoder();
    function randomBytes(length) {
      return webCrypto.getRandomValues(Buffer.alloc(length));
    }
    async function md5(string) {
      try {
        return nodeCrypto.createHash("md5").update(string, "utf-8").digest("hex");
      } catch (e) {
        const data = typeof string === "string" ? textEncoder.encode(string) : string;
        const hash = await subtleCrypto.digest("MD5", data);
        return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    }
    async function postgresMd5PasswordHash(user, password, salt) {
      const inner = await md5(password + user);
      const outer = await md5(Buffer.concat([Buffer.from(inner), salt]));
      return "md5" + outer;
    }
    async function sha256(text) {
      return await subtleCrypto.digest("SHA-256", text);
    }
    async function hashByName(hashName, text) {
      return await subtleCrypto.digest(hashName, text);
    }
    async function hmacSha256(keyBuffer, msg) {
      const key = await subtleCrypto.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return await subtleCrypto.sign("HMAC", key, textEncoder.encode(msg));
    }
    async function deriveKey(password, salt, iterations) {
      const key = await subtleCrypto.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
      const params = { name: "PBKDF2", hash: "SHA-256", salt, iterations };
      return await subtleCrypto.deriveBits(params, key, 32 * 8, ["deriveBits"]);
    }
  }
});

// ../../node_modules/pg/lib/crypto/utils.js
var require_utils2 = __commonJS({
  "../../node_modules/pg/lib/crypto/utils.js"(exports, module) {
    "use strict";
    var useLegacyCrypto = parseInt(process.versions && process.versions.node && process.versions.node.split(".")[0]) < 15;
    if (useLegacyCrypto) {
      module.exports = require_utils_legacy();
    } else {
      module.exports = require_utils_webcrypto();
    }
  }
});

// ../../node_modules/pg/lib/crypto/cert-signatures.js
var require_cert_signatures = __commonJS({
  "../../node_modules/pg/lib/crypto/cert-signatures.js"(exports, module) {
    function x509Error(msg, cert) {
      return new Error("SASL channel binding: " + msg + " when parsing public certificate " + cert.toString("base64"));
    }
    function readASN1Length(data, index) {
      let length = data[index++];
      if (length < 128) return { length, index };
      const lengthBytes = length & 127;
      if (lengthBytes > 4) throw x509Error("bad length", data);
      length = 0;
      for (let i = 0; i < lengthBytes; i++) {
        length = length << 8 | data[index++];
      }
      return { length, index };
    }
    function readASN1OID(data, index) {
      if (data[index++] !== 6) throw x509Error("non-OID data", data);
      const { length: OIDLength, index: indexAfterOIDLength } = readASN1Length(data, index);
      index = indexAfterOIDLength;
      const lastIndex = index + OIDLength;
      const byte1 = data[index++];
      let oid = (byte1 / 40 >> 0) + "." + byte1 % 40;
      while (index < lastIndex) {
        let value = 0;
        while (index < lastIndex) {
          const nextByte = data[index++];
          value = value << 7 | nextByte & 127;
          if (nextByte < 128) break;
        }
        oid += "." + value;
      }
      return { oid, index };
    }
    function expectASN1Seq(data, index) {
      if (data[index++] !== 48) throw x509Error("non-sequence data", data);
      return readASN1Length(data, index);
    }
    function signatureAlgorithmHashFromCertificate(data, index) {
      if (index === void 0) index = 0;
      index = expectASN1Seq(data, index).index;
      const { length: certInfoLength, index: indexAfterCertInfoLength } = expectASN1Seq(data, index);
      index = indexAfterCertInfoLength + certInfoLength;
      index = expectASN1Seq(data, index).index;
      const { oid, index: indexAfterOID } = readASN1OID(data, index);
      switch (oid) {
        // RSA
        case "1.2.840.113549.1.1.4":
          return "MD5";
        case "1.2.840.113549.1.1.5":
          return "SHA-1";
        case "1.2.840.113549.1.1.11":
          return "SHA-256";
        case "1.2.840.113549.1.1.12":
          return "SHA-384";
        case "1.2.840.113549.1.1.13":
          return "SHA-512";
        case "1.2.840.113549.1.1.14":
          return "SHA-224";
        case "1.2.840.113549.1.1.15":
          return "SHA512-224";
        case "1.2.840.113549.1.1.16":
          return "SHA512-256";
        // ECDSA
        case "1.2.840.10045.4.1":
          return "SHA-1";
        case "1.2.840.10045.4.3.1":
          return "SHA-224";
        case "1.2.840.10045.4.3.2":
          return "SHA-256";
        case "1.2.840.10045.4.3.3":
          return "SHA-384";
        case "1.2.840.10045.4.3.4":
          return "SHA-512";
        // RSASSA-PSS: hash is indicated separately
        case "1.2.840.113549.1.1.10": {
          index = indexAfterOID;
          index = expectASN1Seq(data, index).index;
          if (data[index++] !== 160) throw x509Error("non-tag data", data);
          index = readASN1Length(data, index).index;
          index = expectASN1Seq(data, index).index;
          const { oid: hashOID } = readASN1OID(data, index);
          switch (hashOID) {
            // standalone hash OIDs
            case "1.2.840.113549.2.5":
              return "MD5";
            case "1.3.14.3.2.26":
              return "SHA-1";
            case "2.16.840.1.101.3.4.2.1":
              return "SHA-256";
            case "2.16.840.1.101.3.4.2.2":
              return "SHA-384";
            case "2.16.840.1.101.3.4.2.3":
              return "SHA-512";
          }
          throw x509Error("unknown hash OID " + hashOID, data);
        }
        // Ed25519 -- see https: return//github.com/openssl/openssl/issues/15477
        case "1.3.101.110":
        case "1.3.101.112":
          return "SHA-512";
        // Ed448 -- still not in pg 17.2 (if supported, digest would be SHAKE256 x 64 bytes)
        case "1.3.101.111":
        case "1.3.101.113":
          throw x509Error("Ed448 certificate channel binding is not currently supported by Postgres");
      }
      throw x509Error("unknown OID " + oid, data);
    }
    module.exports = { signatureAlgorithmHashFromCertificate };
  }
});

// ../../node_modules/pg/lib/crypto/sasl.js
var require_sasl = __commonJS({
  "../../node_modules/pg/lib/crypto/sasl.js"(exports, module) {
    "use strict";
    var crypto = require_utils2();
    var { signatureAlgorithmHashFromCertificate } = require_cert_signatures();
    function startSession(mechanisms, stream) {
      const candidates = ["SCRAM-SHA-256"];
      if (stream) candidates.unshift("SCRAM-SHA-256-PLUS");
      const mechanism = candidates.find((candidate) => mechanisms.includes(candidate));
      if (!mechanism) {
        throw new Error("SASL: Only mechanism(s) " + candidates.join(" and ") + " are supported");
      }
      if (mechanism === "SCRAM-SHA-256-PLUS" && typeof stream.getPeerCertificate !== "function") {
        throw new Error("SASL: Mechanism SCRAM-SHA-256-PLUS requires a certificate");
      }
      const clientNonce = crypto.randomBytes(18).toString("base64");
      const gs2Header = mechanism === "SCRAM-SHA-256-PLUS" ? "p=tls-server-end-point" : stream ? "y" : "n";
      return {
        mechanism,
        clientNonce,
        response: gs2Header + ",,n=*,r=" + clientNonce,
        message: "SASLInitialResponse"
      };
    }
    async function continueSession(session, password, serverData, stream) {
      if (session.message !== "SASLInitialResponse") {
        throw new Error("SASL: Last message was not SASLInitialResponse");
      }
      if (typeof password !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");
      }
      if (password === "") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string");
      }
      if (typeof serverData !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: serverData must be a string");
      }
      const sv = parseServerFirstMessage(serverData);
      if (!sv.nonce.startsWith(session.clientNonce)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce does not start with client nonce");
      } else if (sv.nonce.length === session.clientNonce.length) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce is too short");
      }
      const clientFirstMessageBare = "n=*,r=" + session.clientNonce;
      const serverFirstMessage = "r=" + sv.nonce + ",s=" + sv.salt + ",i=" + sv.iteration;
      let channelBinding = stream ? "eSws" : "biws";
      if (session.mechanism === "SCRAM-SHA-256-PLUS") {
        const peerCert = stream.getPeerCertificate().raw;
        let hashName = signatureAlgorithmHashFromCertificate(peerCert);
        if (hashName === "MD5" || hashName === "SHA-1") hashName = "SHA-256";
        const certHash = await crypto.hashByName(hashName, peerCert);
        const bindingData = Buffer.concat([Buffer.from("p=tls-server-end-point,,"), Buffer.from(certHash)]);
        channelBinding = bindingData.toString("base64");
      }
      const clientFinalMessageWithoutProof = "c=" + channelBinding + ",r=" + sv.nonce;
      const authMessage = clientFirstMessageBare + "," + serverFirstMessage + "," + clientFinalMessageWithoutProof;
      const saltBytes = Buffer.from(sv.salt, "base64");
      const saltedPassword = await crypto.deriveKey(password, saltBytes, sv.iteration);
      const clientKey = await crypto.hmacSha256(saltedPassword, "Client Key");
      const storedKey = await crypto.sha256(clientKey);
      const clientSignature = await crypto.hmacSha256(storedKey, authMessage);
      const clientProof = xorBuffers(Buffer.from(clientKey), Buffer.from(clientSignature)).toString("base64");
      const serverKey = await crypto.hmacSha256(saltedPassword, "Server Key");
      const serverSignatureBytes = await crypto.hmacSha256(serverKey, authMessage);
      session.message = "SASLResponse";
      session.serverSignature = Buffer.from(serverSignatureBytes).toString("base64");
      session.response = clientFinalMessageWithoutProof + ",p=" + clientProof;
    }
    function finalizeSession(session, serverData) {
      if (session.message !== "SASLResponse") {
        throw new Error("SASL: Last message was not SASLResponse");
      }
      if (typeof serverData !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: serverData must be a string");
      }
      const { serverSignature } = parseServerFinalMessage(serverData);
      if (serverSignature !== session.serverSignature) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature does not match");
      }
    }
    function isPrintableChars(text) {
      if (typeof text !== "string") {
        throw new TypeError("SASL: text must be a string");
      }
      return text.split("").map((_, i) => text.charCodeAt(i)).every((c) => c >= 33 && c <= 43 || c >= 45 && c <= 126);
    }
    function isBase64(text) {
      return /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(text);
    }
    function parseAttributePairs(text) {
      if (typeof text !== "string") {
        throw new TypeError("SASL: attribute pairs text must be a string");
      }
      return new Map(
        text.split(",").map((attrValue) => {
          if (!/^.=/.test(attrValue)) {
            throw new Error("SASL: Invalid attribute pair entry");
          }
          const name = attrValue[0];
          const value = attrValue.substring(2);
          return [name, value];
        })
      );
    }
    function parseServerFirstMessage(data) {
      const attrPairs = parseAttributePairs(data);
      const nonce = attrPairs.get("r");
      if (!nonce) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce missing");
      } else if (!isPrintableChars(nonce)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce must only contain printable characters");
      }
      const salt = attrPairs.get("s");
      if (!salt) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt missing");
      } else if (!isBase64(salt)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt must be base64");
      }
      const iterationText = attrPairs.get("i");
      if (!iterationText) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration missing");
      } else if (!/^[1-9][0-9]*$/.test(iterationText)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: invalid iteration count");
      }
      const iteration = parseInt(iterationText, 10);
      return {
        nonce,
        salt,
        iteration
      };
    }
    function parseServerFinalMessage(serverData) {
      const attrPairs = parseAttributePairs(serverData);
      const serverSignature = attrPairs.get("v");
      if (!serverSignature) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature is missing");
      } else if (!isBase64(serverSignature)) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature must be base64");
      }
      return {
        serverSignature
      };
    }
    function xorBuffers(a, b) {
      if (!Buffer.isBuffer(a)) {
        throw new TypeError("first argument must be a Buffer");
      }
      if (!Buffer.isBuffer(b)) {
        throw new TypeError("second argument must be a Buffer");
      }
      if (a.length !== b.length) {
        throw new Error("Buffer lengths must match");
      }
      if (a.length === 0) {
        throw new Error("Buffers cannot be empty");
      }
      return Buffer.from(a.map((_, i) => a[i] ^ b[i]));
    }
    module.exports = {
      startSession,
      continueSession,
      finalizeSession
    };
  }
});

// ../../node_modules/pg/lib/type-overrides.js
var require_type_overrides = __commonJS({
  "../../node_modules/pg/lib/type-overrides.js"(exports, module) {
    "use strict";
    var types2 = require_pg_types();
    function TypeOverrides2(userTypes) {
      this._types = userTypes || types2;
      this.text = {};
      this.binary = {};
    }
    TypeOverrides2.prototype.getOverrides = function(format) {
      switch (format) {
        case "text":
          return this.text;
        case "binary":
          return this.binary;
        default:
          return {};
      }
    };
    TypeOverrides2.prototype.setTypeParser = function(oid, format, parseFn) {
      if (typeof format === "function") {
        parseFn = format;
        format = "text";
      }
      this.getOverrides(format)[oid] = parseFn;
    };
    TypeOverrides2.prototype.getTypeParser = function(oid, format) {
      format = format || "text";
      return this.getOverrides(format)[oid] || this._types.getTypeParser(oid, format);
    };
    module.exports = TypeOverrides2;
  }
});

// ../../node_modules/pg-connection-string/index.js
var require_pg_connection_string = __commonJS({
  "../../node_modules/pg-connection-string/index.js"(exports, module) {
    "use strict";
    function parse(str, options = {}) {
      if (str.charAt(0) === "/") {
        const config2 = str.split(" ");
        return { host: config2[0], database: config2[1] };
      }
      const config = {};
      let result;
      let dummyHost = false;
      if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) {
        str = encodeURI(str).replace(/%25(\d\d)/g, "%$1");
      }
      try {
        try {
          result = new URL(str, "postgres://base");
        } catch (e) {
          result = new URL(str.replace("@/", "@___DUMMY___/"), "postgres://base");
          dummyHost = true;
        }
      } catch (err) {
        err.input && (err.input = "*****REDACTED*****");
        throw err;
      }
      for (const entry of result.searchParams.entries()) {
        config[entry[0]] = entry[1];
      }
      config.user = config.user || decodeURIComponent(result.username);
      config.password = config.password || decodeURIComponent(result.password);
      if (result.protocol == "socket:") {
        config.host = decodeURI(result.pathname);
        config.database = result.searchParams.get("db");
        config.client_encoding = result.searchParams.get("encoding");
        return config;
      }
      const hostname = dummyHost ? "" : result.hostname;
      if (!config.host) {
        config.host = decodeURIComponent(hostname);
      } else if (hostname && /^%2f/i.test(hostname)) {
        result.pathname = hostname + result.pathname;
      }
      if (!config.port) {
        config.port = result.port;
      }
      const pathname = result.pathname.slice(1) || null;
      config.database = pathname ? decodeURI(pathname) : null;
      if (config.ssl === "true" || config.ssl === "1") {
        config.ssl = true;
      }
      if (config.ssl === "0") {
        config.ssl = false;
      }
      if (config.sslcert || config.sslkey || config.sslrootcert || config.sslmode) {
        config.ssl = {};
      }
      const fs = config.sslcert || config.sslkey || config.sslrootcert ? __require("fs") : null;
      if (config.sslcert) {
        config.ssl.cert = fs.readFileSync(config.sslcert).toString();
      }
      if (config.sslkey) {
        config.ssl.key = fs.readFileSync(config.sslkey).toString();
      }
      if (config.sslrootcert) {
        config.ssl.ca = fs.readFileSync(config.sslrootcert).toString();
      }
      if (options.useLibpqCompat && config.uselibpqcompat) {
        throw new Error("Both useLibpqCompat and uselibpqcompat are set. Please use only one of them.");
      }
      if (config.uselibpqcompat === "true" || options.useLibpqCompat) {
        switch (config.sslmode) {
          case "disable": {
            config.ssl = false;
            break;
          }
          case "prefer": {
            config.ssl.rejectUnauthorized = false;
            break;
          }
          case "require": {
            if (config.sslrootcert) {
              config.ssl.checkServerIdentity = function() {
              };
            } else {
              config.ssl.rejectUnauthorized = false;
            }
            break;
          }
          case "verify-ca": {
            if (!config.ssl.ca) {
              throw new Error(
                "SECURITY WARNING: Using sslmode=verify-ca requires specifying a CA with sslrootcert. If a public CA is used, verify-ca allows connections to a server that somebody else may have registered with the CA, making you vulnerable to Man-in-the-Middle attacks. Either specify a custom CA certificate with sslrootcert parameter or use sslmode=verify-full for proper security."
              );
            }
            config.ssl.checkServerIdentity = function() {
            };
            break;
          }
          case "verify-full": {
            break;
          }
        }
      } else {
        switch (config.sslmode) {
          case "disable": {
            config.ssl = false;
            break;
          }
          case "prefer":
          case "require":
          case "verify-ca":
          case "verify-full": {
            if (config.sslmode !== "verify-full") {
              deprecatedSslModeWarning(config.sslmode);
            }
            break;
          }
          case "no-verify": {
            config.ssl.rejectUnauthorized = false;
            break;
          }
        }
      }
      return config;
    }
    function toConnectionOptions(sslConfig) {
      const connectionOptions = Object.entries(sslConfig).reduce((c, [key, value]) => {
        if (value !== void 0 && value !== null) {
          c[key] = value;
        }
        return c;
      }, {});
      return connectionOptions;
    }
    function toClientConfig(config) {
      const poolConfig = Object.entries(config).reduce((c, [key, value]) => {
        if (key === "ssl") {
          const sslConfig = value;
          if (typeof sslConfig === "boolean") {
            c[key] = sslConfig;
          }
          if (typeof sslConfig === "object") {
            c[key] = toConnectionOptions(sslConfig);
          }
        } else if (value !== void 0 && value !== null) {
          if (key === "port") {
            if (value !== "") {
              const v = parseInt(value, 10);
              if (isNaN(v)) {
                throw new Error(`Invalid ${key}: ${value}`);
              }
              c[key] = v;
            }
          } else {
            c[key] = value;
          }
        }
        return c;
      }, {});
      return poolConfig;
    }
    function parseIntoClientConfig(str) {
      return toClientConfig(parse(str));
    }
    function deprecatedSslModeWarning(sslmode) {
      if (!deprecatedSslModeWarning.warned && typeof process !== "undefined" && process.emitWarning) {
        deprecatedSslModeWarning.warned = true;
        process.emitWarning(`SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.

To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=${sslmode}'

See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.`);
      }
    }
    module.exports = parse;
    parse.parse = parse;
    parse.toClientConfig = toClientConfig;
    parse.parseIntoClientConfig = parseIntoClientConfig;
  }
});

// ../../node_modules/pg/lib/connection-parameters.js
var require_connection_parameters = __commonJS({
  "../../node_modules/pg/lib/connection-parameters.js"(exports, module) {
    "use strict";
    var dns = __require("dns");
    var defaults2 = require_defaults();
    var parse = require_pg_connection_string().parse;
    var val = function(key, config, envVar) {
      if (config[key]) {
        return config[key];
      }
      if (envVar === void 0) {
        envVar = process.env["PG" + key.toUpperCase()];
      } else if (envVar === false) {
      } else {
        envVar = process.env[envVar];
      }
      return envVar || defaults2[key];
    };
    var readSSLConfigFromEnvironment = function() {
      switch (process.env.PGSSLMODE) {
        case "disable":
          return false;
        case "prefer":
        case "require":
        case "verify-ca":
        case "verify-full":
          return true;
        case "no-verify":
          return { rejectUnauthorized: false };
      }
      return defaults2.ssl;
    };
    var quoteParamValue = function(value) {
      return "'" + ("" + value).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    };
    var add = function(params, config, paramName) {
      const value = config[paramName];
      if (value !== void 0 && value !== null) {
        params.push(paramName + "=" + quoteParamValue(value));
      }
    };
    var ConnectionParameters = class {
      constructor(config) {
        config = typeof config === "string" ? parse(config) : config || {};
        if (config.connectionString) {
          config = Object.assign({}, config, parse(config.connectionString));
        }
        this.user = val("user", config);
        this.database = val("database", config);
        if (this.database === void 0) {
          this.database = this.user;
        }
        this.port = parseInt(val("port", config), 10);
        this.host = val("host", config);
        Object.defineProperty(this, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: val("password", config)
        });
        this.binary = val("binary", config);
        this.options = val("options", config);
        this.ssl = typeof config.ssl === "undefined" ? readSSLConfigFromEnvironment() : config.ssl;
        if (typeof this.ssl === "string") {
          if (this.ssl === "true") {
            this.ssl = true;
          }
        }
        if (this.ssl === "no-verify") {
          this.ssl = { rejectUnauthorized: false };
        }
        if (this.ssl && this.ssl.key) {
          Object.defineProperty(this.ssl, "key", {
            enumerable: false
          });
        }
        this.client_encoding = val("client_encoding", config);
        this.replication = val("replication", config);
        this.isDomainSocket = !(this.host || "").indexOf("/");
        this.application_name = val("application_name", config, "PGAPPNAME");
        this.fallback_application_name = val("fallback_application_name", config, false);
        this.statement_timeout = val("statement_timeout", config, false);
        this.lock_timeout = val("lock_timeout", config, false);
        this.idle_in_transaction_session_timeout = val("idle_in_transaction_session_timeout", config, false);
        this.query_timeout = val("query_timeout", config, false);
        if (config.connectionTimeoutMillis === void 0) {
          this.connect_timeout = process.env.PGCONNECT_TIMEOUT || 0;
        } else {
          this.connect_timeout = Math.floor(config.connectionTimeoutMillis / 1e3);
        }
        if (config.keepAlive === false) {
          this.keepalives = 0;
        } else if (config.keepAlive === true) {
          this.keepalives = 1;
        }
        if (typeof config.keepAliveInitialDelayMillis === "number") {
          this.keepalives_idle = Math.floor(config.keepAliveInitialDelayMillis / 1e3);
        }
      }
      getLibpqConnectionString(cb) {
        const params = [];
        add(params, this, "user");
        add(params, this, "password");
        add(params, this, "port");
        add(params, this, "application_name");
        add(params, this, "fallback_application_name");
        add(params, this, "connect_timeout");
        add(params, this, "options");
        const ssl = typeof this.ssl === "object" ? this.ssl : this.ssl ? { sslmode: this.ssl } : {};
        add(params, ssl, "sslmode");
        add(params, ssl, "sslca");
        add(params, ssl, "sslkey");
        add(params, ssl, "sslcert");
        add(params, ssl, "sslrootcert");
        if (this.database) {
          params.push("dbname=" + quoteParamValue(this.database));
        }
        if (this.replication) {
          params.push("replication=" + quoteParamValue(this.replication));
        }
        if (this.host) {
          params.push("host=" + quoteParamValue(this.host));
        }
        if (this.isDomainSocket) {
          return cb(null, params.join(" "));
        }
        if (this.client_encoding) {
          params.push("client_encoding=" + quoteParamValue(this.client_encoding));
        }
        dns.lookup(this.host, function(err, address) {
          if (err) return cb(err, null);
          params.push("hostaddr=" + quoteParamValue(address));
          return cb(null, params.join(" "));
        });
      }
    };
    module.exports = ConnectionParameters;
  }
});

// ../../node_modules/pg/lib/result.js
var require_result = __commonJS({
  "../../node_modules/pg/lib/result.js"(exports, module) {
    "use strict";
    var types2 = require_pg_types();
    var matchRegexp = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/;
    var Result2 = class {
      constructor(rowMode, types3) {
        this.command = null;
        this.rowCount = null;
        this.oid = null;
        this.rows = [];
        this.fields = [];
        this._parsers = void 0;
        this._types = types3;
        this.RowCtor = null;
        this.rowAsArray = rowMode === "array";
        if (this.rowAsArray) {
          this.parseRow = this._parseRowAsArray;
        }
        this._prebuiltEmptyResultObject = null;
      }
      // adds a command complete message
      addCommandComplete(msg) {
        let match;
        if (msg.text) {
          match = matchRegexp.exec(msg.text);
        } else {
          match = matchRegexp.exec(msg.command);
        }
        if (match) {
          this.command = match[1];
          if (match[3]) {
            this.oid = parseInt(match[2], 10);
            this.rowCount = parseInt(match[3], 10);
          } else if (match[2]) {
            this.rowCount = parseInt(match[2], 10);
          }
        }
      }
      _parseRowAsArray(rowData) {
        const row = new Array(rowData.length);
        for (let i = 0, len = rowData.length; i < len; i++) {
          const rawValue = rowData[i];
          if (rawValue !== null) {
            row[i] = this._parsers[i](rawValue);
          } else {
            row[i] = null;
          }
        }
        return row;
      }
      parseRow(rowData) {
        const row = { ...this._prebuiltEmptyResultObject };
        for (let i = 0, len = rowData.length; i < len; i++) {
          const rawValue = rowData[i];
          const field = this.fields[i].name;
          if (rawValue !== null) {
            const v = this.fields[i].format === "binary" ? Buffer.from(rawValue) : rawValue;
            row[field] = this._parsers[i](v);
          } else {
            row[field] = null;
          }
        }
        return row;
      }
      addRow(row) {
        this.rows.push(row);
      }
      addFields(fieldDescriptions) {
        this.fields = fieldDescriptions;
        if (this.fields.length) {
          this._parsers = new Array(fieldDescriptions.length);
        }
        const row = {};
        for (let i = 0; i < fieldDescriptions.length; i++) {
          const desc = fieldDescriptions[i];
          row[desc.name] = null;
          if (this._types) {
            this._parsers[i] = this._types.getTypeParser(desc.dataTypeID, desc.format || "text");
          } else {
            this._parsers[i] = types2.getTypeParser(desc.dataTypeID, desc.format || "text");
          }
        }
        this._prebuiltEmptyResultObject = { ...row };
      }
    };
    module.exports = Result2;
  }
});

// ../../node_modules/pg/lib/query.js
var require_query = __commonJS({
  "../../node_modules/pg/lib/query.js"(exports, module) {
    "use strict";
    var { EventEmitter } = __require("events");
    var Result2 = require_result();
    var utils = require_utils();
    var Query2 = class extends EventEmitter {
      constructor(config, values, callback) {
        super();
        config = utils.normalizeQueryConfig(config, values, callback);
        this.text = config.text;
        this.values = config.values;
        this.rows = config.rows;
        this.types = config.types;
        this.name = config.name;
        this.queryMode = config.queryMode;
        this.binary = config.binary;
        this.portal = config.portal || "";
        this.callback = config.callback;
        this._rowMode = config.rowMode;
        if (process.domain && config.callback) {
          this.callback = process.domain.bind(config.callback);
        }
        this._result = new Result2(this._rowMode, this.types);
        this._results = this._result;
        this._canceledDueToError = false;
      }
      requiresPreparation() {
        if (this.queryMode === "extended") {
          return true;
        }
        if (this.name) {
          return true;
        }
        if (this.rows) {
          return true;
        }
        if (!this.text) {
          return false;
        }
        if (!this.values) {
          return false;
        }
        return this.values.length > 0;
      }
      _checkForMultirow() {
        if (this._result.command) {
          if (!Array.isArray(this._results)) {
            this._results = [this._result];
          }
          this._result = new Result2(this._rowMode, this._result._types);
          this._results.push(this._result);
        }
      }
      // associates row metadata from the supplied
      // message with this query object
      // metadata used when parsing row results
      handleRowDescription(msg) {
        this._checkForMultirow();
        this._result.addFields(msg.fields);
        this._accumulateRows = this.callback || !this.listeners("row").length;
      }
      handleDataRow(msg) {
        let row;
        if (this._canceledDueToError) {
          return;
        }
        try {
          row = this._result.parseRow(msg.fields);
        } catch (err) {
          this._canceledDueToError = err;
          return;
        }
        this.emit("row", row, this._result);
        if (this._accumulateRows) {
          this._result.addRow(row);
        }
      }
      handleCommandComplete(msg, connection) {
        this._checkForMultirow();
        this._result.addCommandComplete(msg);
        if (this.rows) {
          connection.sync();
        }
      }
      // if a named prepared statement is created with empty query text
      // the backend will send an emptyQuery message but *not* a command complete message
      // since we pipeline sync immediately after execute we don't need to do anything here
      // unless we have rows specified, in which case we did not pipeline the initial sync call
      handleEmptyQuery(connection) {
        if (this.rows) {
          connection.sync();
        }
      }
      handleError(err, connection) {
        if (this._canceledDueToError) {
          err = this._canceledDueToError;
          this._canceledDueToError = false;
        }
        if (this.callback) {
          return this.callback(err);
        }
        this.emit("error", err);
      }
      handleReadyForQuery(con) {
        if (this._canceledDueToError) {
          return this.handleError(this._canceledDueToError, con);
        }
        if (this.callback) {
          try {
            this.callback(null, this._results);
          } catch (err) {
            process.nextTick(() => {
              throw err;
            });
          }
        }
        this.emit("end", this._results);
      }
      submit(connection) {
        if (typeof this.text !== "string" && typeof this.name !== "string") {
          return new Error("A query must have either text or a name. Supplying neither is unsupported.");
        }
        const previous = connection.parsedStatements[this.name];
        if (this.text && previous && this.text !== previous) {
          return new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
        }
        if (this.values && !Array.isArray(this.values)) {
          return new Error("Query values must be an array");
        }
        if (this.requiresPreparation()) {
          connection.stream.cork && connection.stream.cork();
          try {
            this.prepare(connection);
          } finally {
            connection.stream.uncork && connection.stream.uncork();
          }
        } else {
          connection.query(this.text);
        }
        return null;
      }
      hasBeenParsed(connection) {
        return this.name && connection.parsedStatements[this.name];
      }
      handlePortalSuspended(connection) {
        this._getRows(connection, this.rows);
      }
      _getRows(connection, rows) {
        connection.execute({
          portal: this.portal,
          rows
        });
        if (!rows) {
          connection.sync();
        } else {
          connection.flush();
        }
      }
      // http://developer.postgresql.org/pgdocs/postgres/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY
      prepare(connection) {
        if (!this.hasBeenParsed(connection)) {
          connection.parse({
            text: this.text,
            name: this.name,
            types: this.types
          });
        }
        try {
          connection.bind({
            portal: this.portal,
            statement: this.name,
            values: this.values,
            binary: this.binary,
            valueMapper: utils.prepareValue
          });
        } catch (err) {
          this.handleError(err, connection);
          return;
        }
        connection.describe({
          type: "P",
          name: this.portal || ""
        });
        this._getRows(connection, this.rows);
      }
      handleCopyInResponse(connection) {
        connection.sendCopyFail("No source stream defined");
      }
      handleCopyData(msg, connection) {
      }
    };
    module.exports = Query2;
  }
});

// ../../node_modules/pg-protocol/dist/messages.js
var require_messages = __commonJS({
  "../../node_modules/pg-protocol/dist/messages.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoticeMessage = exports.DataRowMessage = exports.CommandCompleteMessage = exports.ReadyForQueryMessage = exports.NotificationResponseMessage = exports.BackendKeyDataMessage = exports.AuthenticationMD5Password = exports.ParameterStatusMessage = exports.ParameterDescriptionMessage = exports.RowDescriptionMessage = exports.Field = exports.CopyResponse = exports.CopyDataMessage = exports.DatabaseError = exports.copyDone = exports.emptyQuery = exports.replicationStart = exports.portalSuspended = exports.noData = exports.closeComplete = exports.bindComplete = exports.parseComplete = void 0;
    exports.parseComplete = {
      name: "parseComplete",
      length: 5
    };
    exports.bindComplete = {
      name: "bindComplete",
      length: 5
    };
    exports.closeComplete = {
      name: "closeComplete",
      length: 5
    };
    exports.noData = {
      name: "noData",
      length: 5
    };
    exports.portalSuspended = {
      name: "portalSuspended",
      length: 5
    };
    exports.replicationStart = {
      name: "replicationStart",
      length: 4
    };
    exports.emptyQuery = {
      name: "emptyQuery",
      length: 4
    };
    exports.copyDone = {
      name: "copyDone",
      length: 4
    };
    var DatabaseError2 = class extends Error {
      constructor(message, length, name) {
        super(message);
        this.length = length;
        this.name = name;
      }
    };
    exports.DatabaseError = DatabaseError2;
    var CopyDataMessage = class {
      constructor(length, chunk) {
        this.length = length;
        this.chunk = chunk;
        this.name = "copyData";
      }
    };
    exports.CopyDataMessage = CopyDataMessage;
    var CopyResponse = class {
      constructor(length, name, binary, columnCount) {
        this.length = length;
        this.name = name;
        this.binary = binary;
        this.columnTypes = new Array(columnCount);
      }
    };
    exports.CopyResponse = CopyResponse;
    var Field = class {
      constructor(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, format) {
        this.name = name;
        this.tableID = tableID;
        this.columnID = columnID;
        this.dataTypeID = dataTypeID;
        this.dataTypeSize = dataTypeSize;
        this.dataTypeModifier = dataTypeModifier;
        this.format = format;
      }
    };
    exports.Field = Field;
    var RowDescriptionMessage = class {
      constructor(length, fieldCount) {
        this.length = length;
        this.fieldCount = fieldCount;
        this.name = "rowDescription";
        this.fields = new Array(this.fieldCount);
      }
    };
    exports.RowDescriptionMessage = RowDescriptionMessage;
    var ParameterDescriptionMessage = class {
      constructor(length, parameterCount) {
        this.length = length;
        this.parameterCount = parameterCount;
        this.name = "parameterDescription";
        this.dataTypeIDs = new Array(this.parameterCount);
      }
    };
    exports.ParameterDescriptionMessage = ParameterDescriptionMessage;
    var ParameterStatusMessage = class {
      constructor(length, parameterName, parameterValue) {
        this.length = length;
        this.parameterName = parameterName;
        this.parameterValue = parameterValue;
        this.name = "parameterStatus";
      }
    };
    exports.ParameterStatusMessage = ParameterStatusMessage;
    var AuthenticationMD5Password = class {
      constructor(length, salt) {
        this.length = length;
        this.salt = salt;
        this.name = "authenticationMD5Password";
      }
    };
    exports.AuthenticationMD5Password = AuthenticationMD5Password;
    var BackendKeyDataMessage = class {
      constructor(length, processID, secretKey) {
        this.length = length;
        this.processID = processID;
        this.secretKey = secretKey;
        this.name = "backendKeyData";
      }
    };
    exports.BackendKeyDataMessage = BackendKeyDataMessage;
    var NotificationResponseMessage = class {
      constructor(length, processId, channel, payload) {
        this.length = length;
        this.processId = processId;
        this.channel = channel;
        this.payload = payload;
        this.name = "notification";
      }
    };
    exports.NotificationResponseMessage = NotificationResponseMessage;
    var ReadyForQueryMessage = class {
      constructor(length, status) {
        this.length = length;
        this.status = status;
        this.name = "readyForQuery";
      }
    };
    exports.ReadyForQueryMessage = ReadyForQueryMessage;
    var CommandCompleteMessage = class {
      constructor(length, text) {
        this.length = length;
        this.text = text;
        this.name = "commandComplete";
      }
    };
    exports.CommandCompleteMessage = CommandCompleteMessage;
    var DataRowMessage = class {
      constructor(length, fields) {
        this.length = length;
        this.fields = fields;
        this.name = "dataRow";
        this.fieldCount = fields.length;
      }
    };
    exports.DataRowMessage = DataRowMessage;
    var NoticeMessage = class {
      constructor(length, message) {
        this.length = length;
        this.message = message;
        this.name = "notice";
      }
    };
    exports.NoticeMessage = NoticeMessage;
  }
});

// ../../node_modules/pg-protocol/dist/buffer-writer.js
var require_buffer_writer = __commonJS({
  "../../node_modules/pg-protocol/dist/buffer-writer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Writer = void 0;
    var Writer = class {
      constructor(size = 256) {
        this.size = size;
        this.offset = 5;
        this.headerPosition = 0;
        this.buffer = Buffer.allocUnsafe(size);
      }
      ensure(size) {
        const remaining = this.buffer.length - this.offset;
        if (remaining < size) {
          const oldBuffer = this.buffer;
          const newSize = oldBuffer.length + (oldBuffer.length >> 1) + size;
          this.buffer = Buffer.allocUnsafe(newSize);
          oldBuffer.copy(this.buffer);
        }
      }
      addInt32(num) {
        this.ensure(4);
        this.buffer[this.offset++] = num >>> 24 & 255;
        this.buffer[this.offset++] = num >>> 16 & 255;
        this.buffer[this.offset++] = num >>> 8 & 255;
        this.buffer[this.offset++] = num >>> 0 & 255;
        return this;
      }
      addInt16(num) {
        this.ensure(2);
        this.buffer[this.offset++] = num >>> 8 & 255;
        this.buffer[this.offset++] = num >>> 0 & 255;
        return this;
      }
      addCString(string) {
        if (!string) {
          this.ensure(1);
        } else {
          const len = Buffer.byteLength(string);
          this.ensure(len + 1);
          this.buffer.write(string, this.offset, "utf-8");
          this.offset += len;
        }
        this.buffer[this.offset++] = 0;
        return this;
      }
      addString(string = "") {
        const len = Buffer.byteLength(string);
        this.ensure(len);
        this.buffer.write(string, this.offset);
        this.offset += len;
        return this;
      }
      add(otherBuffer) {
        this.ensure(otherBuffer.length);
        otherBuffer.copy(this.buffer, this.offset);
        this.offset += otherBuffer.length;
        return this;
      }
      join(code) {
        if (code) {
          this.buffer[this.headerPosition] = code;
          const length = this.offset - (this.headerPosition + 1);
          this.buffer.writeInt32BE(length, this.headerPosition + 1);
        }
        return this.buffer.slice(code ? 0 : 5, this.offset);
      }
      flush(code) {
        const result = this.join(code);
        this.offset = 5;
        this.headerPosition = 0;
        this.buffer = Buffer.allocUnsafe(this.size);
        return result;
      }
    };
    exports.Writer = Writer;
  }
});

// ../../node_modules/pg-protocol/dist/serializer.js
var require_serializer = __commonJS({
  "../../node_modules/pg-protocol/dist/serializer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serialize = void 0;
    var buffer_writer_1 = require_buffer_writer();
    var writer = new buffer_writer_1.Writer();
    var startup = (opts) => {
      writer.addInt16(3).addInt16(0);
      for (const key of Object.keys(opts)) {
        writer.addCString(key).addCString(opts[key]);
      }
      writer.addCString("client_encoding").addCString("UTF8");
      const bodyBuffer = writer.addCString("").flush();
      const length = bodyBuffer.length + 4;
      return new buffer_writer_1.Writer().addInt32(length).add(bodyBuffer).flush();
    };
    var requestSsl = () => {
      const response = Buffer.allocUnsafe(8);
      response.writeInt32BE(8, 0);
      response.writeInt32BE(80877103, 4);
      return response;
    };
    var password = (password2) => {
      return writer.addCString(password2).flush(
        112
        /* code.startup */
      );
    };
    var sendSASLInitialResponseMessage = function(mechanism, initialResponse) {
      writer.addCString(mechanism).addInt32(Buffer.byteLength(initialResponse)).addString(initialResponse);
      return writer.flush(
        112
        /* code.startup */
      );
    };
    var sendSCRAMClientFinalMessage = function(additionalData) {
      return writer.addString(additionalData).flush(
        112
        /* code.startup */
      );
    };
    var query = (text) => {
      return writer.addCString(text).flush(
        81
        /* code.query */
      );
    };
    var emptyArray = [];
    var parse = (query2) => {
      const name = query2.name || "";
      if (name.length > 63) {
        console.error("Warning! Postgres only supports 63 characters for query names.");
        console.error("You supplied %s (%s)", name, name.length);
        console.error("This can cause conflicts and silent errors executing queries");
      }
      const types2 = query2.types || emptyArray;
      const len = types2.length;
      const buffer = writer.addCString(name).addCString(query2.text).addInt16(len);
      for (let i = 0; i < len; i++) {
        buffer.addInt32(types2[i]);
      }
      return writer.flush(
        80
        /* code.parse */
      );
    };
    var paramWriter = new buffer_writer_1.Writer();
    var writeValues = function(values, valueMapper) {
      for (let i = 0; i < values.length; i++) {
        const mappedVal = valueMapper ? valueMapper(values[i], i) : values[i];
        if (mappedVal == null) {
          writer.addInt16(
            0
            /* ParamType.STRING */
          );
          paramWriter.addInt32(-1);
        } else if (mappedVal instanceof Buffer) {
          writer.addInt16(
            1
            /* ParamType.BINARY */
          );
          paramWriter.addInt32(mappedVal.length);
          paramWriter.add(mappedVal);
        } else {
          writer.addInt16(
            0
            /* ParamType.STRING */
          );
          paramWriter.addInt32(Buffer.byteLength(mappedVal));
          paramWriter.addString(mappedVal);
        }
      }
    };
    var bind = (config = {}) => {
      const portal = config.portal || "";
      const statement = config.statement || "";
      const binary = config.binary || false;
      const values = config.values || emptyArray;
      const len = values.length;
      writer.addCString(portal).addCString(statement);
      writer.addInt16(len);
      writeValues(values, config.valueMapper);
      writer.addInt16(len);
      writer.add(paramWriter.flush());
      writer.addInt16(1);
      writer.addInt16(
        binary ? 1 : 0
        /* ParamType.STRING */
      );
      return writer.flush(
        66
        /* code.bind */
      );
    };
    var emptyExecute = Buffer.from([69, 0, 0, 0, 9, 0, 0, 0, 0, 0]);
    var execute = (config) => {
      if (!config || !config.portal && !config.rows) {
        return emptyExecute;
      }
      const portal = config.portal || "";
      const rows = config.rows || 0;
      const portalLength = Buffer.byteLength(portal);
      const len = 4 + portalLength + 1 + 4;
      const buff = Buffer.allocUnsafe(1 + len);
      buff[0] = 69;
      buff.writeInt32BE(len, 1);
      buff.write(portal, 5, "utf-8");
      buff[portalLength + 5] = 0;
      buff.writeUInt32BE(rows, buff.length - 4);
      return buff;
    };
    var cancel = (processID, secretKey) => {
      const buffer = Buffer.allocUnsafe(16);
      buffer.writeInt32BE(16, 0);
      buffer.writeInt16BE(1234, 4);
      buffer.writeInt16BE(5678, 6);
      buffer.writeInt32BE(processID, 8);
      buffer.writeInt32BE(secretKey, 12);
      return buffer;
    };
    var cstringMessage = (code, string) => {
      const stringLen = Buffer.byteLength(string);
      const len = 4 + stringLen + 1;
      const buffer = Buffer.allocUnsafe(1 + len);
      buffer[0] = code;
      buffer.writeInt32BE(len, 1);
      buffer.write(string, 5, "utf-8");
      buffer[len] = 0;
      return buffer;
    };
    var emptyDescribePortal = writer.addCString("P").flush(
      68
      /* code.describe */
    );
    var emptyDescribeStatement = writer.addCString("S").flush(
      68
      /* code.describe */
    );
    var describe = (msg) => {
      return msg.name ? cstringMessage(68, `${msg.type}${msg.name || ""}`) : msg.type === "P" ? emptyDescribePortal : emptyDescribeStatement;
    };
    var close = (msg) => {
      const text = `${msg.type}${msg.name || ""}`;
      return cstringMessage(67, text);
    };
    var copyData = (chunk) => {
      return writer.add(chunk).flush(
        100
        /* code.copyFromChunk */
      );
    };
    var copyFail = (message) => {
      return cstringMessage(102, message);
    };
    var codeOnlyBuffer = (code) => Buffer.from([code, 0, 0, 0, 4]);
    var flushBuffer = codeOnlyBuffer(
      72
      /* code.flush */
    );
    var syncBuffer = codeOnlyBuffer(
      83
      /* code.sync */
    );
    var endBuffer = codeOnlyBuffer(
      88
      /* code.end */
    );
    var copyDoneBuffer = codeOnlyBuffer(
      99
      /* code.copyDone */
    );
    var serialize = {
      startup,
      password,
      requestSsl,
      sendSASLInitialResponseMessage,
      sendSCRAMClientFinalMessage,
      query,
      parse,
      bind,
      execute,
      describe,
      close,
      flush: () => flushBuffer,
      sync: () => syncBuffer,
      end: () => endBuffer,
      copyData,
      copyDone: () => copyDoneBuffer,
      copyFail,
      cancel
    };
    exports.serialize = serialize;
  }
});

// ../../node_modules/pg-protocol/dist/buffer-reader.js
var require_buffer_reader = __commonJS({
  "../../node_modules/pg-protocol/dist/buffer-reader.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BufferReader = void 0;
    var BufferReader = class {
      constructor(offset = 0) {
        this.offset = offset;
        this.buffer = Buffer.allocUnsafe(0);
        this.encoding = "utf-8";
      }
      setBuffer(offset, buffer) {
        this.offset = offset;
        this.buffer = buffer;
      }
      int16() {
        const result = this.buffer.readInt16BE(this.offset);
        this.offset += 2;
        return result;
      }
      byte() {
        const result = this.buffer[this.offset];
        this.offset++;
        return result;
      }
      int32() {
        const result = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return result;
      }
      uint32() {
        const result = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return result;
      }
      string(length) {
        const result = this.buffer.toString(this.encoding, this.offset, this.offset + length);
        this.offset += length;
        return result;
      }
      cstring() {
        const start = this.offset;
        let end = start;
        while (this.buffer[end++] !== 0) {
        }
        this.offset = end;
        return this.buffer.toString(this.encoding, start, end - 1);
      }
      bytes(length) {
        const result = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return result;
      }
    };
    exports.BufferReader = BufferReader;
  }
});

// ../../node_modules/pg-protocol/dist/parser.js
var require_parser = __commonJS({
  "../../node_modules/pg-protocol/dist/parser.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Parser = void 0;
    var messages_1 = require_messages();
    var buffer_reader_1 = require_buffer_reader();
    var CODE_LENGTH = 1;
    var LEN_LENGTH = 4;
    var HEADER_LENGTH = CODE_LENGTH + LEN_LENGTH;
    var LATEINIT_LENGTH = -1;
    var emptyBuffer = Buffer.allocUnsafe(0);
    var Parser = class {
      constructor(opts) {
        this.buffer = emptyBuffer;
        this.bufferLength = 0;
        this.bufferOffset = 0;
        this.reader = new buffer_reader_1.BufferReader();
        if ((opts === null || opts === void 0 ? void 0 : opts.mode) === "binary") {
          throw new Error("Binary mode not supported yet");
        }
        this.mode = (opts === null || opts === void 0 ? void 0 : opts.mode) || "text";
      }
      parse(buffer, callback) {
        this.mergeBuffer(buffer);
        const bufferFullLength = this.bufferOffset + this.bufferLength;
        let offset = this.bufferOffset;
        while (offset + HEADER_LENGTH <= bufferFullLength) {
          const code = this.buffer[offset];
          const length = this.buffer.readUInt32BE(offset + CODE_LENGTH);
          const fullMessageLength = CODE_LENGTH + length;
          if (fullMessageLength + offset <= bufferFullLength) {
            const message = this.handlePacket(offset + HEADER_LENGTH, code, length, this.buffer);
            callback(message);
            offset += fullMessageLength;
          } else {
            break;
          }
        }
        if (offset === bufferFullLength) {
          this.buffer = emptyBuffer;
          this.bufferLength = 0;
          this.bufferOffset = 0;
        } else {
          this.bufferLength = bufferFullLength - offset;
          this.bufferOffset = offset;
        }
      }
      mergeBuffer(buffer) {
        if (this.bufferLength > 0) {
          const newLength = this.bufferLength + buffer.byteLength;
          const newFullLength = newLength + this.bufferOffset;
          if (newFullLength > this.buffer.byteLength) {
            let newBuffer;
            if (newLength <= this.buffer.byteLength && this.bufferOffset >= this.bufferLength) {
              newBuffer = this.buffer;
            } else {
              let newBufferLength = this.buffer.byteLength * 2;
              while (newLength >= newBufferLength) {
                newBufferLength *= 2;
              }
              newBuffer = Buffer.allocUnsafe(newBufferLength);
            }
            this.buffer.copy(newBuffer, 0, this.bufferOffset, this.bufferOffset + this.bufferLength);
            this.buffer = newBuffer;
            this.bufferOffset = 0;
          }
          buffer.copy(this.buffer, this.bufferOffset + this.bufferLength);
          this.bufferLength = newLength;
        } else {
          this.buffer = buffer;
          this.bufferOffset = 0;
          this.bufferLength = buffer.byteLength;
        }
      }
      handlePacket(offset, code, length, bytes) {
        const { reader } = this;
        reader.setBuffer(offset, bytes);
        let message;
        switch (code) {
          case 50:
            message = messages_1.bindComplete;
            break;
          case 49:
            message = messages_1.parseComplete;
            break;
          case 51:
            message = messages_1.closeComplete;
            break;
          case 110:
            message = messages_1.noData;
            break;
          case 115:
            message = messages_1.portalSuspended;
            break;
          case 99:
            message = messages_1.copyDone;
            break;
          case 87:
            message = messages_1.replicationStart;
            break;
          case 73:
            message = messages_1.emptyQuery;
            break;
          case 68:
            message = parseDataRowMessage(reader);
            break;
          case 67:
            message = parseCommandCompleteMessage(reader);
            break;
          case 90:
            message = parseReadyForQueryMessage(reader);
            break;
          case 65:
            message = parseNotificationMessage(reader);
            break;
          case 82:
            message = parseAuthenticationResponse(reader, length);
            break;
          case 83:
            message = parseParameterStatusMessage(reader);
            break;
          case 75:
            message = parseBackendKeyData(reader);
            break;
          case 69:
            message = parseErrorMessage(reader, "error");
            break;
          case 78:
            message = parseErrorMessage(reader, "notice");
            break;
          case 84:
            message = parseRowDescriptionMessage(reader);
            break;
          case 116:
            message = parseParameterDescriptionMessage(reader);
            break;
          case 71:
            message = parseCopyInMessage(reader);
            break;
          case 72:
            message = parseCopyOutMessage(reader);
            break;
          case 100:
            message = parseCopyData(reader, length);
            break;
          default:
            return new messages_1.DatabaseError("received invalid response: " + code.toString(16), length, "error");
        }
        reader.setBuffer(0, emptyBuffer);
        message.length = length;
        return message;
      }
    };
    exports.Parser = Parser;
    var parseReadyForQueryMessage = (reader) => {
      const status = reader.string(1);
      return new messages_1.ReadyForQueryMessage(LATEINIT_LENGTH, status);
    };
    var parseCommandCompleteMessage = (reader) => {
      const text = reader.cstring();
      return new messages_1.CommandCompleteMessage(LATEINIT_LENGTH, text);
    };
    var parseCopyData = (reader, length) => {
      const chunk = reader.bytes(length - 4);
      return new messages_1.CopyDataMessage(LATEINIT_LENGTH, chunk);
    };
    var parseCopyInMessage = (reader) => parseCopyMessage(reader, "copyInResponse");
    var parseCopyOutMessage = (reader) => parseCopyMessage(reader, "copyOutResponse");
    var parseCopyMessage = (reader, messageName) => {
      const isBinary = reader.byte() !== 0;
      const columnCount = reader.int16();
      const message = new messages_1.CopyResponse(LATEINIT_LENGTH, messageName, isBinary, columnCount);
      for (let i = 0; i < columnCount; i++) {
        message.columnTypes[i] = reader.int16();
      }
      return message;
    };
    var parseNotificationMessage = (reader) => {
      const processId = reader.int32();
      const channel = reader.cstring();
      const payload = reader.cstring();
      return new messages_1.NotificationResponseMessage(LATEINIT_LENGTH, processId, channel, payload);
    };
    var parseRowDescriptionMessage = (reader) => {
      const fieldCount = reader.int16();
      const message = new messages_1.RowDescriptionMessage(LATEINIT_LENGTH, fieldCount);
      for (let i = 0; i < fieldCount; i++) {
        message.fields[i] = parseField(reader);
      }
      return message;
    };
    var parseField = (reader) => {
      const name = reader.cstring();
      const tableID = reader.uint32();
      const columnID = reader.int16();
      const dataTypeID = reader.uint32();
      const dataTypeSize = reader.int16();
      const dataTypeModifier = reader.int32();
      const mode = reader.int16() === 0 ? "text" : "binary";
      return new messages_1.Field(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, mode);
    };
    var parseParameterDescriptionMessage = (reader) => {
      const parameterCount = reader.int16();
      const message = new messages_1.ParameterDescriptionMessage(LATEINIT_LENGTH, parameterCount);
      for (let i = 0; i < parameterCount; i++) {
        message.dataTypeIDs[i] = reader.int32();
      }
      return message;
    };
    var parseDataRowMessage = (reader) => {
      const fieldCount = reader.int16();
      const fields = new Array(fieldCount);
      for (let i = 0; i < fieldCount; i++) {
        const len = reader.int32();
        fields[i] = len === -1 ? null : reader.string(len);
      }
      return new messages_1.DataRowMessage(LATEINIT_LENGTH, fields);
    };
    var parseParameterStatusMessage = (reader) => {
      const name = reader.cstring();
      const value = reader.cstring();
      return new messages_1.ParameterStatusMessage(LATEINIT_LENGTH, name, value);
    };
    var parseBackendKeyData = (reader) => {
      const processID = reader.int32();
      const secretKey = reader.int32();
      return new messages_1.BackendKeyDataMessage(LATEINIT_LENGTH, processID, secretKey);
    };
    var parseAuthenticationResponse = (reader, length) => {
      const code = reader.int32();
      const message = {
        name: "authenticationOk",
        length
      };
      switch (code) {
        case 0:
          break;
        case 3:
          if (message.length === 8) {
            message.name = "authenticationCleartextPassword";
          }
          break;
        case 5:
          if (message.length === 12) {
            message.name = "authenticationMD5Password";
            const salt = reader.bytes(4);
            return new messages_1.AuthenticationMD5Password(LATEINIT_LENGTH, salt);
          }
          break;
        case 10:
          {
            message.name = "authenticationSASL";
            message.mechanisms = [];
            let mechanism;
            do {
              mechanism = reader.cstring();
              if (mechanism) {
                message.mechanisms.push(mechanism);
              }
            } while (mechanism);
          }
          break;
        case 11:
          message.name = "authenticationSASLContinue";
          message.data = reader.string(length - 8);
          break;
        case 12:
          message.name = "authenticationSASLFinal";
          message.data = reader.string(length - 8);
          break;
        default:
          throw new Error("Unknown authenticationOk message type " + code);
      }
      return message;
    };
    var parseErrorMessage = (reader, name) => {
      const fields = {};
      let fieldType = reader.string(1);
      while (fieldType !== "\0") {
        fields[fieldType] = reader.cstring();
        fieldType = reader.string(1);
      }
      const messageValue = fields.M;
      const message = name === "notice" ? new messages_1.NoticeMessage(LATEINIT_LENGTH, messageValue) : new messages_1.DatabaseError(messageValue, LATEINIT_LENGTH, name);
      message.severity = fields.S;
      message.code = fields.C;
      message.detail = fields.D;
      message.hint = fields.H;
      message.position = fields.P;
      message.internalPosition = fields.p;
      message.internalQuery = fields.q;
      message.where = fields.W;
      message.schema = fields.s;
      message.table = fields.t;
      message.column = fields.c;
      message.dataType = fields.d;
      message.constraint = fields.n;
      message.file = fields.F;
      message.line = fields.L;
      message.routine = fields.R;
      return message;
    };
  }
});

// ../../node_modules/pg-protocol/dist/index.js
var require_dist = __commonJS({
  "../../node_modules/pg-protocol/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DatabaseError = exports.serialize = exports.parse = void 0;
    var messages_1 = require_messages();
    Object.defineProperty(exports, "DatabaseError", { enumerable: true, get: function() {
      return messages_1.DatabaseError;
    } });
    var serializer_1 = require_serializer();
    Object.defineProperty(exports, "serialize", { enumerable: true, get: function() {
      return serializer_1.serialize;
    } });
    var parser_1 = require_parser();
    function parse(stream, callback) {
      const parser = new parser_1.Parser();
      stream.on("data", (buffer) => parser.parse(buffer, callback));
      return new Promise((resolve3) => stream.on("end", () => resolve3()));
    }
    exports.parse = parse;
  }
});

// ../../node_modules/pg-cloudflare/dist/empty.js
var require_empty = __commonJS({
  "../../node_modules/pg-cloudflare/dist/empty.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = {};
  }
});

// ../../node_modules/pg/lib/stream.js
var require_stream = __commonJS({
  "../../node_modules/pg/lib/stream.js"(exports, module) {
    var { getStream, getSecureStream } = getStreamFuncs();
    module.exports = {
      /**
       * Get a socket stream compatible with the current runtime environment.
       * @returns {Duplex}
       */
      getStream,
      /**
       * Get a TLS secured socket, compatible with the current environment,
       * using the socket and other settings given in `options`.
       * @returns {Duplex}
       */
      getSecureStream
    };
    function getNodejsStreamFuncs() {
      function getStream2(ssl) {
        const net = __require("net");
        return new net.Socket();
      }
      function getSecureStream2(options) {
        const tls = __require("tls");
        return tls.connect(options);
      }
      return {
        getStream: getStream2,
        getSecureStream: getSecureStream2
      };
    }
    function getCloudflareStreamFuncs() {
      function getStream2(ssl) {
        const { CloudflareSocket } = require_empty();
        return new CloudflareSocket(ssl);
      }
      function getSecureStream2(options) {
        options.socket.startTls(options);
        return options.socket;
      }
      return {
        getStream: getStream2,
        getSecureStream: getSecureStream2
      };
    }
    function isCloudflareRuntime() {
      if (typeof navigator === "object" && navigator !== null && typeof navigator.userAgent === "string") {
        return navigator.userAgent === "Cloudflare-Workers";
      }
      if (typeof Response === "function") {
        const resp = new Response(null, { cf: { thing: true } });
        if (typeof resp.cf === "object" && resp.cf !== null && resp.cf.thing) {
          return true;
        }
      }
      return false;
    }
    function getStreamFuncs() {
      if (isCloudflareRuntime()) {
        return getCloudflareStreamFuncs();
      }
      return getNodejsStreamFuncs();
    }
  }
});

// ../../node_modules/pg/lib/connection.js
var require_connection = __commonJS({
  "../../node_modules/pg/lib/connection.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var { parse, serialize } = require_dist();
    var { getStream, getSecureStream } = require_stream();
    var flushBuffer = serialize.flush();
    var syncBuffer = serialize.sync();
    var endBuffer = serialize.end();
    var Connection2 = class extends EventEmitter {
      constructor(config) {
        super();
        config = config || {};
        this.stream = config.stream || getStream(config.ssl);
        if (typeof this.stream === "function") {
          this.stream = this.stream(config);
        }
        this._keepAlive = config.keepAlive;
        this._keepAliveInitialDelayMillis = config.keepAliveInitialDelayMillis;
        this.parsedStatements = {};
        this.ssl = config.ssl || false;
        this._ending = false;
        this._emitMessage = false;
        const self = this;
        this.on("newListener", function(eventName) {
          if (eventName === "message") {
            self._emitMessage = true;
          }
        });
      }
      connect(port, host) {
        const self = this;
        this._connecting = true;
        this.stream.setNoDelay(true);
        this.stream.connect(port, host);
        this.stream.once("connect", function() {
          if (self._keepAlive) {
            self.stream.setKeepAlive(true, self._keepAliveInitialDelayMillis);
          }
          self.emit("connect");
        });
        const reportStreamError = function(error) {
          if (self._ending && (error.code === "ECONNRESET" || error.code === "EPIPE")) {
            return;
          }
          self.emit("error", error);
        };
        this.stream.on("error", reportStreamError);
        this.stream.on("close", function() {
          self.emit("end");
        });
        if (!this.ssl) {
          return this.attachListeners(this.stream);
        }
        this.stream.once("data", function(buffer) {
          const responseCode = buffer.toString("utf8");
          switch (responseCode) {
            case "S":
              break;
            case "N":
              self.stream.end();
              return self.emit("error", new Error("The server does not support SSL connections"));
            default:
              self.stream.end();
              return self.emit("error", new Error("There was an error establishing an SSL connection"));
          }
          const options = {
            socket: self.stream
          };
          if (self.ssl !== true) {
            Object.assign(options, self.ssl);
            if ("key" in self.ssl) {
              options.key = self.ssl.key;
            }
          }
          const net = __require("net");
          if (net.isIP && net.isIP(host) === 0) {
            options.servername = host;
          }
          try {
            self.stream = getSecureStream(options);
          } catch (err) {
            return self.emit("error", err);
          }
          self.attachListeners(self.stream);
          self.stream.on("error", reportStreamError);
          self.emit("sslconnect");
        });
      }
      attachListeners(stream) {
        parse(stream, (msg) => {
          const eventName = msg.name === "error" ? "errorMessage" : msg.name;
          if (this._emitMessage) {
            this.emit("message", msg);
          }
          this.emit(eventName, msg);
        });
      }
      requestSsl() {
        this.stream.write(serialize.requestSsl());
      }
      startup(config) {
        this.stream.write(serialize.startup(config));
      }
      cancel(processID, secretKey) {
        this._send(serialize.cancel(processID, secretKey));
      }
      password(password) {
        this._send(serialize.password(password));
      }
      sendSASLInitialResponseMessage(mechanism, initialResponse) {
        this._send(serialize.sendSASLInitialResponseMessage(mechanism, initialResponse));
      }
      sendSCRAMClientFinalMessage(additionalData) {
        this._send(serialize.sendSCRAMClientFinalMessage(additionalData));
      }
      _send(buffer) {
        if (!this.stream.writable) {
          return false;
        }
        return this.stream.write(buffer);
      }
      query(text) {
        this._send(serialize.query(text));
      }
      // send parse message
      parse(query) {
        this._send(serialize.parse(query));
      }
      // send bind message
      bind(config) {
        this._send(serialize.bind(config));
      }
      // send execute message
      execute(config) {
        this._send(serialize.execute(config));
      }
      flush() {
        if (this.stream.writable) {
          this.stream.write(flushBuffer);
        }
      }
      sync() {
        this._ending = true;
        this._send(syncBuffer);
      }
      ref() {
        this.stream.ref();
      }
      unref() {
        this.stream.unref();
      }
      end() {
        this._ending = true;
        if (!this._connecting || !this.stream.writable) {
          this.stream.end();
          return;
        }
        return this.stream.write(endBuffer, () => {
          this.stream.end();
        });
      }
      close(msg) {
        this._send(serialize.close(msg));
      }
      describe(msg) {
        this._send(serialize.describe(msg));
      }
      sendCopyFromChunk(chunk) {
        this._send(serialize.copyData(chunk));
      }
      endCopyFrom() {
        this._send(serialize.copyDone());
      }
      sendCopyFail(msg) {
        this._send(serialize.copyFail(msg));
      }
    };
    module.exports = Connection2;
  }
});

// ../../node_modules/split2/index.js
var require_split2 = __commonJS({
  "../../node_modules/split2/index.js"(exports, module) {
    "use strict";
    var { Transform } = __require("stream");
    var { StringDecoder } = __require("string_decoder");
    var kLast = Symbol("last");
    var kDecoder = Symbol("decoder");
    function transform(chunk, enc, cb) {
      let list;
      if (this.overflow) {
        const buf = this[kDecoder].write(chunk);
        list = buf.split(this.matcher);
        if (list.length === 1) return cb();
        list.shift();
        this.overflow = false;
      } else {
        this[kLast] += this[kDecoder].write(chunk);
        list = this[kLast].split(this.matcher);
      }
      this[kLast] = list.pop();
      for (let i = 0; i < list.length; i++) {
        try {
          push(this, this.mapper(list[i]));
        } catch (error) {
          return cb(error);
        }
      }
      this.overflow = this[kLast].length > this.maxLength;
      if (this.overflow && !this.skipOverflow) {
        cb(new Error("maximum buffer reached"));
        return;
      }
      cb();
    }
    function flush(cb) {
      this[kLast] += this[kDecoder].end();
      if (this[kLast]) {
        try {
          push(this, this.mapper(this[kLast]));
        } catch (error) {
          return cb(error);
        }
      }
      cb();
    }
    function push(self, val) {
      if (val !== void 0) {
        self.push(val);
      }
    }
    function noop(incoming) {
      return incoming;
    }
    function split(matcher, mapper, options) {
      matcher = matcher || /\r?\n/;
      mapper = mapper || noop;
      options = options || {};
      switch (arguments.length) {
        case 1:
          if (typeof matcher === "function") {
            mapper = matcher;
            matcher = /\r?\n/;
          } else if (typeof matcher === "object" && !(matcher instanceof RegExp) && !matcher[Symbol.split]) {
            options = matcher;
            matcher = /\r?\n/;
          }
          break;
        case 2:
          if (typeof matcher === "function") {
            options = mapper;
            mapper = matcher;
            matcher = /\r?\n/;
          } else if (typeof mapper === "object") {
            options = mapper;
            mapper = noop;
          }
      }
      options = Object.assign({}, options);
      options.autoDestroy = true;
      options.transform = transform;
      options.flush = flush;
      options.readableObjectMode = true;
      const stream = new Transform(options);
      stream[kLast] = "";
      stream[kDecoder] = new StringDecoder("utf8");
      stream.matcher = matcher;
      stream.mapper = mapper;
      stream.maxLength = options.maxLength;
      stream.skipOverflow = options.skipOverflow || false;
      stream.overflow = false;
      stream._destroy = function(err, cb) {
        this._writableState.errorEmitted = false;
        cb(err);
      };
      return stream;
    }
    module.exports = split;
  }
});

// ../../node_modules/pgpass/lib/helper.js
var require_helper = __commonJS({
  "../../node_modules/pgpass/lib/helper.js"(exports, module) {
    "use strict";
    var path = __require("path");
    var Stream = __require("stream").Stream;
    var split = require_split2();
    var util = __require("util");
    var defaultPort = 5432;
    var isWin = process.platform === "win32";
    var warnStream = process.stderr;
    var S_IRWXG = 56;
    var S_IRWXO = 7;
    var S_IFMT = 61440;
    var S_IFREG = 32768;
    function isRegFile(mode) {
      return (mode & S_IFMT) == S_IFREG;
    }
    var fieldNames = ["host", "port", "database", "user", "password"];
    var nrOfFields = fieldNames.length;
    var passKey = fieldNames[nrOfFields - 1];
    function warn() {
      var isWritable = warnStream instanceof Stream && true === warnStream.writable;
      if (isWritable) {
        var args = Array.prototype.slice.call(arguments).concat("\n");
        warnStream.write(util.format.apply(util, args));
      }
    }
    Object.defineProperty(module.exports, "isWin", {
      get: function() {
        return isWin;
      },
      set: function(val) {
        isWin = val;
      }
    });
    module.exports.warnTo = function(stream) {
      var old = warnStream;
      warnStream = stream;
      return old;
    };
    module.exports.getFileName = function(rawEnv) {
      var env = rawEnv || process.env;
      var file = env.PGPASSFILE || (isWin ? path.join(env.APPDATA || "./", "postgresql", "pgpass.conf") : path.join(env.HOME || "./", ".pgpass"));
      return file;
    };
    module.exports.usePgPass = function(stats, fname) {
      if (Object.prototype.hasOwnProperty.call(process.env, "PGPASSWORD")) {
        return false;
      }
      if (isWin) {
        return true;
      }
      fname = fname || "<unkn>";
      if (!isRegFile(stats.mode)) {
        warn('WARNING: password file "%s" is not a plain file', fname);
        return false;
      }
      if (stats.mode & (S_IRWXG | S_IRWXO)) {
        warn('WARNING: password file "%s" has group or world access; permissions should be u=rw (0600) or less', fname);
        return false;
      }
      return true;
    };
    var matcher = module.exports.match = function(connInfo, entry) {
      return fieldNames.slice(0, -1).reduce(function(prev, field, idx) {
        if (idx == 1) {
          if (Number(connInfo[field] || defaultPort) === Number(entry[field])) {
            return prev && true;
          }
        }
        return prev && (entry[field] === "*" || entry[field] === connInfo[field]);
      }, true);
    };
    module.exports.getPassword = function(connInfo, stream, cb) {
      var pass;
      var lineStream = stream.pipe(split());
      function onLine(line) {
        var entry = parseLine(line);
        if (entry && isValidEntry(entry) && matcher(connInfo, entry)) {
          pass = entry[passKey];
          lineStream.end();
        }
      }
      var onEnd = function() {
        stream.destroy();
        cb(pass);
      };
      var onErr = function(err) {
        stream.destroy();
        warn("WARNING: error on reading file: %s", err);
        cb(void 0);
      };
      stream.on("error", onErr);
      lineStream.on("data", onLine).on("end", onEnd).on("error", onErr);
    };
    var parseLine = module.exports.parseLine = function(line) {
      if (line.length < 11 || line.match(/^\s+#/)) {
        return null;
      }
      var curChar = "";
      var prevChar = "";
      var fieldIdx = 0;
      var startIdx = 0;
      var endIdx = 0;
      var obj = {};
      var isLastField = false;
      var addToObj = function(idx, i0, i1) {
        var field = line.substring(i0, i1);
        if (!Object.hasOwnProperty.call(process.env, "PGPASS_NO_DEESCAPE")) {
          field = field.replace(/\\([:\\])/g, "$1");
        }
        obj[fieldNames[idx]] = field;
      };
      for (var i = 0; i < line.length - 1; i += 1) {
        curChar = line.charAt(i + 1);
        prevChar = line.charAt(i);
        isLastField = fieldIdx == nrOfFields - 1;
        if (isLastField) {
          addToObj(fieldIdx, startIdx);
          break;
        }
        if (i >= 0 && curChar == ":" && prevChar !== "\\") {
          addToObj(fieldIdx, startIdx, i + 1);
          startIdx = i + 2;
          fieldIdx += 1;
        }
      }
      obj = Object.keys(obj).length === nrOfFields ? obj : null;
      return obj;
    };
    var isValidEntry = module.exports.isValidEntry = function(entry) {
      var rules = {
        // host
        0: function(x) {
          return x.length > 0;
        },
        // port
        1: function(x) {
          if (x === "*") {
            return true;
          }
          x = Number(x);
          return isFinite(x) && x > 0 && x < 9007199254740992 && Math.floor(x) === x;
        },
        // database
        2: function(x) {
          return x.length > 0;
        },
        // username
        3: function(x) {
          return x.length > 0;
        },
        // password
        4: function(x) {
          return x.length > 0;
        }
      };
      for (var idx = 0; idx < fieldNames.length; idx += 1) {
        var rule = rules[idx];
        var value = entry[fieldNames[idx]] || "";
        var res = rule(value);
        if (!res) {
          return false;
        }
      }
      return true;
    };
  }
});

// ../../node_modules/pgpass/lib/index.js
var require_lib = __commonJS({
  "../../node_modules/pgpass/lib/index.js"(exports, module) {
    "use strict";
    var path = __require("path");
    var fs = __require("fs");
    var helper = require_helper();
    module.exports = function(connInfo, cb) {
      var file = helper.getFileName();
      fs.stat(file, function(err, stat) {
        if (err || !helper.usePgPass(stat, file)) {
          return cb(void 0);
        }
        var st = fs.createReadStream(file);
        helper.getPassword(connInfo, st, cb);
      });
    };
    module.exports.warnTo = helper.warnTo;
  }
});

// ../../node_modules/pg/lib/client.js
var require_client = __commonJS({
  "../../node_modules/pg/lib/client.js"(exports, module) {
    var EventEmitter = __require("events").EventEmitter;
    var utils = require_utils();
    var nodeUtils = __require("util");
    var sasl = require_sasl();
    var TypeOverrides2 = require_type_overrides();
    var ConnectionParameters = require_connection_parameters();
    var Query2 = require_query();
    var defaults2 = require_defaults();
    var Connection2 = require_connection();
    var crypto = require_utils2();
    var activeQueryDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Client.activeQuery is deprecated and will be removed in pg@9.0"
    );
    var queryQueueDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Client.queryQueue is deprecated and will be removed in pg@9.0."
    );
    var pgPassDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "pgpass support is deprecated and will be removed in pg@9.0. You can provide an async function as the password property to the Client/Pool constructor that returns a password instead. Within this function you can call the pgpass module in your own code."
    );
    var byoPromiseDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Passing a custom Promise implementation to the Client/Pool constructor is deprecated and will be removed in pg@9.0."
    );
    var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."
    );
    var Client2 = class extends EventEmitter {
      constructor(config) {
        super();
        this.connectionParameters = new ConnectionParameters(config);
        this.user = this.connectionParameters.user;
        this.database = this.connectionParameters.database;
        this.port = this.connectionParameters.port;
        this.host = this.connectionParameters.host;
        Object.defineProperty(this, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: this.connectionParameters.password
        });
        this.replication = this.connectionParameters.replication;
        const c = config || {};
        if (c.Promise) {
          byoPromiseDeprecationNotice();
        }
        this._Promise = c.Promise || global.Promise;
        this._types = new TypeOverrides2(c.types);
        this._ending = false;
        this._ended = false;
        this._connecting = false;
        this._connected = false;
        this._connectionError = false;
        this._queryable = true;
        this._activeQuery = null;
        this.enableChannelBinding = Boolean(c.enableChannelBinding);
        this.connection = c.connection || new Connection2({
          stream: c.stream,
          ssl: this.connectionParameters.ssl,
          keepAlive: c.keepAlive || false,
          keepAliveInitialDelayMillis: c.keepAliveInitialDelayMillis || 0,
          encoding: this.connectionParameters.client_encoding || "utf8"
        });
        this._queryQueue = [];
        this.binary = c.binary || defaults2.binary;
        this.processID = null;
        this.secretKey = null;
        this.ssl = this.connectionParameters.ssl || false;
        if (this.ssl && this.ssl.key) {
          Object.defineProperty(this.ssl, "key", {
            enumerable: false
          });
        }
        this._connectionTimeoutMillis = c.connectionTimeoutMillis || 0;
      }
      get activeQuery() {
        activeQueryDeprecationNotice();
        return this._activeQuery;
      }
      set activeQuery(val) {
        activeQueryDeprecationNotice();
        this._activeQuery = val;
      }
      _getActiveQuery() {
        return this._activeQuery;
      }
      _errorAllQueries(err) {
        const enqueueError = (query) => {
          process.nextTick(() => {
            query.handleError(err, this.connection);
          });
        };
        const activeQuery = this._getActiveQuery();
        if (activeQuery) {
          enqueueError(activeQuery);
          this._activeQuery = null;
        }
        this._queryQueue.forEach(enqueueError);
        this._queryQueue.length = 0;
      }
      _connect(callback) {
        const self = this;
        const con = this.connection;
        this._connectionCallback = callback;
        if (this._connecting || this._connected) {
          const err = new Error("Client has already been connected. You cannot reuse a client.");
          process.nextTick(() => {
            callback(err);
          });
          return;
        }
        this._connecting = true;
        if (this._connectionTimeoutMillis > 0) {
          this.connectionTimeoutHandle = setTimeout(() => {
            con._ending = true;
            con.stream.destroy(new Error("timeout expired"));
          }, this._connectionTimeoutMillis);
          if (this.connectionTimeoutHandle.unref) {
            this.connectionTimeoutHandle.unref();
          }
        }
        if (this.host && this.host.indexOf("/") === 0) {
          con.connect(this.host + "/.s.PGSQL." + this.port);
        } else {
          con.connect(this.port, this.host);
        }
        con.on("connect", function() {
          if (self.ssl) {
            con.requestSsl();
          } else {
            con.startup(self.getStartupConf());
          }
        });
        con.on("sslconnect", function() {
          con.startup(self.getStartupConf());
        });
        this._attachListeners(con);
        con.once("end", () => {
          const error = this._ending ? new Error("Connection terminated") : new Error("Connection terminated unexpectedly");
          clearTimeout(this.connectionTimeoutHandle);
          this._errorAllQueries(error);
          this._ended = true;
          if (!this._ending) {
            if (this._connecting && !this._connectionError) {
              if (this._connectionCallback) {
                this._connectionCallback(error);
              } else {
                this._handleErrorEvent(error);
              }
            } else if (!this._connectionError) {
              this._handleErrorEvent(error);
            }
          }
          process.nextTick(() => {
            this.emit("end");
          });
        });
      }
      connect(callback) {
        if (callback) {
          this._connect(callback);
          return;
        }
        return new this._Promise((resolve3, reject) => {
          this._connect((error) => {
            if (error) {
              reject(error);
            } else {
              resolve3(this);
            }
          });
        });
      }
      _attachListeners(con) {
        con.on("authenticationCleartextPassword", this._handleAuthCleartextPassword.bind(this));
        con.on("authenticationMD5Password", this._handleAuthMD5Password.bind(this));
        con.on("authenticationSASL", this._handleAuthSASL.bind(this));
        con.on("authenticationSASLContinue", this._handleAuthSASLContinue.bind(this));
        con.on("authenticationSASLFinal", this._handleAuthSASLFinal.bind(this));
        con.on("backendKeyData", this._handleBackendKeyData.bind(this));
        con.on("error", this._handleErrorEvent.bind(this));
        con.on("errorMessage", this._handleErrorMessage.bind(this));
        con.on("readyForQuery", this._handleReadyForQuery.bind(this));
        con.on("notice", this._handleNotice.bind(this));
        con.on("rowDescription", this._handleRowDescription.bind(this));
        con.on("dataRow", this._handleDataRow.bind(this));
        con.on("portalSuspended", this._handlePortalSuspended.bind(this));
        con.on("emptyQuery", this._handleEmptyQuery.bind(this));
        con.on("commandComplete", this._handleCommandComplete.bind(this));
        con.on("parseComplete", this._handleParseComplete.bind(this));
        con.on("copyInResponse", this._handleCopyInResponse.bind(this));
        con.on("copyData", this._handleCopyData.bind(this));
        con.on("notification", this._handleNotification.bind(this));
      }
      _getPassword(cb) {
        const con = this.connection;
        if (typeof this.password === "function") {
          this._Promise.resolve().then(() => this.password(this.connectionParameters)).then((pass) => {
            if (pass !== void 0) {
              if (typeof pass !== "string") {
                con.emit("error", new TypeError("Password must be a string"));
                return;
              }
              this.connectionParameters.password = this.password = pass;
            } else {
              this.connectionParameters.password = this.password = null;
            }
            cb();
          }).catch((err) => {
            con.emit("error", err);
          });
        } else if (this.password !== null) {
          cb();
        } else {
          try {
            const pgPass = require_lib();
            pgPass(this.connectionParameters, (pass) => {
              if (void 0 !== pass) {
                pgPassDeprecationNotice();
                this.connectionParameters.password = this.password = pass;
              }
              cb();
            });
          } catch (e) {
            this.emit("error", e);
          }
        }
      }
      _handleAuthCleartextPassword(msg) {
        this._getPassword(() => {
          this.connection.password(this.password);
        });
      }
      _handleAuthMD5Password(msg) {
        this._getPassword(async () => {
          try {
            const hashedPassword = await crypto.postgresMd5PasswordHash(this.user, this.password, msg.salt);
            this.connection.password(hashedPassword);
          } catch (e) {
            this.emit("error", e);
          }
        });
      }
      _handleAuthSASL(msg) {
        this._getPassword(() => {
          try {
            this.saslSession = sasl.startSession(msg.mechanisms, this.enableChannelBinding && this.connection.stream);
            this.connection.sendSASLInitialResponseMessage(this.saslSession.mechanism, this.saslSession.response);
          } catch (err) {
            this.connection.emit("error", err);
          }
        });
      }
      async _handleAuthSASLContinue(msg) {
        try {
          await sasl.continueSession(
            this.saslSession,
            this.password,
            msg.data,
            this.enableChannelBinding && this.connection.stream
          );
          this.connection.sendSCRAMClientFinalMessage(this.saslSession.response);
        } catch (err) {
          this.connection.emit("error", err);
        }
      }
      _handleAuthSASLFinal(msg) {
        try {
          sasl.finalizeSession(this.saslSession, msg.data);
          this.saslSession = null;
        } catch (err) {
          this.connection.emit("error", err);
        }
      }
      _handleBackendKeyData(msg) {
        this.processID = msg.processID;
        this.secretKey = msg.secretKey;
      }
      _handleReadyForQuery(msg) {
        if (this._connecting) {
          this._connecting = false;
          this._connected = true;
          clearTimeout(this.connectionTimeoutHandle);
          if (this._connectionCallback) {
            this._connectionCallback(null, this);
            this._connectionCallback = null;
          }
          this.emit("connect");
        }
        const activeQuery = this._getActiveQuery();
        this._activeQuery = null;
        this.readyForQuery = true;
        if (activeQuery) {
          activeQuery.handleReadyForQuery(this.connection);
        }
        this._pulseQueryQueue();
      }
      // if we receive an error event or error message
      // during the connection process we handle it here
      _handleErrorWhileConnecting(err) {
        if (this._connectionError) {
          return;
        }
        this._connectionError = true;
        clearTimeout(this.connectionTimeoutHandle);
        if (this._connectionCallback) {
          return this._connectionCallback(err);
        }
        this.emit("error", err);
      }
      // if we're connected and we receive an error event from the connection
      // this means the socket is dead - do a hard abort of all queries and emit
      // the socket error on the client as well
      _handleErrorEvent(err) {
        if (this._connecting) {
          return this._handleErrorWhileConnecting(err);
        }
        this._queryable = false;
        this._errorAllQueries(err);
        this.emit("error", err);
      }
      // handle error messages from the postgres backend
      _handleErrorMessage(msg) {
        if (this._connecting) {
          return this._handleErrorWhileConnecting(msg);
        }
        const activeQuery = this._getActiveQuery();
        if (!activeQuery) {
          this._handleErrorEvent(msg);
          return;
        }
        this._activeQuery = null;
        activeQuery.handleError(msg, this.connection);
      }
      _handleRowDescription(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected rowDescription message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleRowDescription(msg);
      }
      _handleDataRow(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected dataRow message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleDataRow(msg);
      }
      _handlePortalSuspended(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected portalSuspended message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handlePortalSuspended(this.connection);
      }
      _handleEmptyQuery(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected emptyQuery message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleEmptyQuery(this.connection);
      }
      _handleCommandComplete(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected commandComplete message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCommandComplete(msg, this.connection);
      }
      _handleParseComplete() {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected parseComplete message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        if (activeQuery.name) {
          this.connection.parsedStatements[activeQuery.name] = activeQuery.text;
        }
      }
      _handleCopyInResponse(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected copyInResponse message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCopyInResponse(this.connection);
      }
      _handleCopyData(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected copyData message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCopyData(msg, this.connection);
      }
      _handleNotification(msg) {
        this.emit("notification", msg);
      }
      _handleNotice(msg) {
        this.emit("notice", msg);
      }
      getStartupConf() {
        const params = this.connectionParameters;
        const data = {
          user: params.user,
          database: params.database
        };
        const appName = params.application_name || params.fallback_application_name;
        if (appName) {
          data.application_name = appName;
        }
        if (params.replication) {
          data.replication = "" + params.replication;
        }
        if (params.statement_timeout) {
          data.statement_timeout = String(parseInt(params.statement_timeout, 10));
        }
        if (params.lock_timeout) {
          data.lock_timeout = String(parseInt(params.lock_timeout, 10));
        }
        if (params.idle_in_transaction_session_timeout) {
          data.idle_in_transaction_session_timeout = String(parseInt(params.idle_in_transaction_session_timeout, 10));
        }
        if (params.options) {
          data.options = params.options;
        }
        return data;
      }
      cancel(client, query) {
        if (client.activeQuery === query) {
          const con = this.connection;
          if (this.host && this.host.indexOf("/") === 0) {
            con.connect(this.host + "/.s.PGSQL." + this.port);
          } else {
            con.connect(this.port, this.host);
          }
          con.on("connect", function() {
            con.cancel(client.processID, client.secretKey);
          });
        } else if (client._queryQueue.indexOf(query) !== -1) {
          client._queryQueue.splice(client._queryQueue.indexOf(query), 1);
        }
      }
      setTypeParser(oid, format, parseFn) {
        return this._types.setTypeParser(oid, format, parseFn);
      }
      getTypeParser(oid, format) {
        return this._types.getTypeParser(oid, format);
      }
      // escapeIdentifier and escapeLiteral moved to utility functions & exported
      // on PG
      // re-exported here for backwards compatibility
      escapeIdentifier(str) {
        return utils.escapeIdentifier(str);
      }
      escapeLiteral(str) {
        return utils.escapeLiteral(str);
      }
      _pulseQueryQueue() {
        if (this.readyForQuery === true) {
          this._activeQuery = this._queryQueue.shift();
          const activeQuery = this._getActiveQuery();
          if (activeQuery) {
            this.readyForQuery = false;
            this.hasExecuted = true;
            const queryError = activeQuery.submit(this.connection);
            if (queryError) {
              process.nextTick(() => {
                activeQuery.handleError(queryError, this.connection);
                this.readyForQuery = true;
                this._pulseQueryQueue();
              });
            }
          } else if (this.hasExecuted) {
            this._activeQuery = null;
            this.emit("drain");
          }
        }
      }
      query(config, values, callback) {
        let query;
        let result;
        let readTimeout;
        let readTimeoutTimer;
        let queryCallback;
        if (config === null || config === void 0) {
          throw new TypeError("Client was passed a null or undefined query");
        } else if (typeof config.submit === "function") {
          readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
          result = query = config;
          if (!query.callback) {
            if (typeof values === "function") {
              query.callback = values;
            } else if (callback) {
              query.callback = callback;
            }
          }
        } else {
          readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
          query = new Query2(config, values, callback);
          if (!query.callback) {
            result = new this._Promise((resolve3, reject) => {
              query.callback = (err, res) => err ? reject(err) : resolve3(res);
            }).catch((err) => {
              Error.captureStackTrace(err);
              throw err;
            });
          }
        }
        if (readTimeout) {
          queryCallback = query.callback || (() => {
          });
          readTimeoutTimer = setTimeout(() => {
            const error = new Error("Query read timeout");
            process.nextTick(() => {
              query.handleError(error, this.connection);
            });
            queryCallback(error);
            query.callback = () => {
            };
            const index = this._queryQueue.indexOf(query);
            if (index > -1) {
              this._queryQueue.splice(index, 1);
            }
            this._pulseQueryQueue();
          }, readTimeout);
          query.callback = (err, res) => {
            clearTimeout(readTimeoutTimer);
            queryCallback(err, res);
          };
        }
        if (this.binary && !query.binary) {
          query.binary = true;
        }
        if (query._result && !query._result._types) {
          query._result._types = this._types;
        }
        if (!this._queryable) {
          process.nextTick(() => {
            query.handleError(new Error("Client has encountered a connection error and is not queryable"), this.connection);
          });
          return result;
        }
        if (this._ending) {
          process.nextTick(() => {
            query.handleError(new Error("Client was closed and is not queryable"), this.connection);
          });
          return result;
        }
        if (this._queryQueue.length > 0) {
          queryQueueLengthDeprecationNotice();
        }
        this._queryQueue.push(query);
        this._pulseQueryQueue();
        return result;
      }
      ref() {
        this.connection.ref();
      }
      unref() {
        this.connection.unref();
      }
      end(cb) {
        this._ending = true;
        if (!this.connection._connecting || this._ended) {
          if (cb) {
            cb();
          } else {
            return this._Promise.resolve();
          }
        }
        if (this._getActiveQuery() || !this._queryable) {
          this.connection.stream.destroy();
        } else {
          this.connection.end();
        }
        if (cb) {
          this.connection.once("end", cb);
        } else {
          return new this._Promise((resolve3) => {
            this.connection.once("end", resolve3);
          });
        }
      }
      get queryQueue() {
        queryQueueDeprecationNotice();
        return this._queryQueue;
      }
    };
    Client2.Query = Query2;
    module.exports = Client2;
  }
});

// ../../node_modules/pg-pool/index.js
var require_pg_pool = __commonJS({
  "../../node_modules/pg-pool/index.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var NOOP = function() {
    };
    var removeWhere = (list, predicate) => {
      const i = list.findIndex(predicate);
      return i === -1 ? void 0 : list.splice(i, 1)[0];
    };
    var IdleItem = class {
      constructor(client, idleListener, timeoutId) {
        this.client = client;
        this.idleListener = idleListener;
        this.timeoutId = timeoutId;
      }
    };
    var PendingItem = class {
      constructor(callback) {
        this.callback = callback;
      }
    };
    function throwOnDoubleRelease() {
      throw new Error("Release called on client which has already been released to the pool.");
    }
    function promisify(Promise2, callback) {
      if (callback) {
        return { callback, result: void 0 };
      }
      let rej;
      let res;
      const cb = function(err, client) {
        err ? rej(err) : res(client);
      };
      const result = new Promise2(function(resolve3, reject) {
        res = resolve3;
        rej = reject;
      }).catch((err) => {
        Error.captureStackTrace(err);
        throw err;
      });
      return { callback: cb, result };
    }
    function makeIdleListener(pool, client) {
      return function idleListener(err) {
        err.client = client;
        client.removeListener("error", idleListener);
        client.on("error", () => {
          pool.log("additional client error after disconnection due to error", err);
        });
        pool._remove(client);
        pool.emit("error", err, client);
      };
    }
    var Pool2 = class extends EventEmitter {
      constructor(options, Client2) {
        super();
        this.options = Object.assign({}, options);
        if (options != null && "password" in options) {
          Object.defineProperty(this.options, "password", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: options.password
          });
        }
        if (options != null && options.ssl && options.ssl.key) {
          Object.defineProperty(this.options.ssl, "key", {
            enumerable: false
          });
        }
        this.options.max = this.options.max || this.options.poolSize || 10;
        this.options.min = this.options.min || 0;
        this.options.maxUses = this.options.maxUses || Infinity;
        this.options.allowExitOnIdle = this.options.allowExitOnIdle || false;
        this.options.maxLifetimeSeconds = this.options.maxLifetimeSeconds || 0;
        this.log = this.options.log || function() {
        };
        this.Client = this.options.Client || Client2 || require_lib2().Client;
        this.Promise = this.options.Promise || global.Promise;
        if (typeof this.options.idleTimeoutMillis === "undefined") {
          this.options.idleTimeoutMillis = 1e4;
        }
        this._clients = [];
        this._idle = [];
        this._expired = /* @__PURE__ */ new WeakSet();
        this._pendingQueue = [];
        this._endCallback = void 0;
        this.ending = false;
        this.ended = false;
      }
      _promiseTry(f) {
        const Promise2 = this.Promise;
        if (typeof Promise2.try === "function") {
          return Promise2.try(f);
        }
        return new Promise2((resolve3) => resolve3(f()));
      }
      _isFull() {
        return this._clients.length >= this.options.max;
      }
      _isAboveMin() {
        return this._clients.length > this.options.min;
      }
      _pulseQueue() {
        this.log("pulse queue");
        if (this.ended) {
          this.log("pulse queue ended");
          return;
        }
        if (this.ending) {
          this.log("pulse queue on ending");
          if (this._idle.length) {
            this._idle.slice().map((item) => {
              this._remove(item.client);
            });
          }
          if (!this._clients.length) {
            this.ended = true;
            this._endCallback();
          }
          return;
        }
        if (!this._pendingQueue.length) {
          this.log("no queued requests");
          return;
        }
        if (!this._idle.length && this._isFull()) {
          return;
        }
        const pendingItem = this._pendingQueue.shift();
        if (this._idle.length) {
          const idleItem = this._idle.pop();
          clearTimeout(idleItem.timeoutId);
          const client = idleItem.client;
          client.ref && client.ref();
          const idleListener = idleItem.idleListener;
          return this._acquireClient(client, pendingItem, idleListener, false);
        }
        if (!this._isFull()) {
          return this.newClient(pendingItem);
        }
        throw new Error("unexpected condition");
      }
      _remove(client, callback) {
        const removed = removeWhere(this._idle, (item) => item.client === client);
        if (removed !== void 0) {
          clearTimeout(removed.timeoutId);
        }
        this._clients = this._clients.filter((c) => c !== client);
        const context = this;
        client.end(() => {
          context.emit("remove", client);
          if (typeof callback === "function") {
            callback();
          }
        });
      }
      connect(cb) {
        if (this.ending) {
          const err = new Error("Cannot use a pool after calling end on the pool");
          return cb ? cb(err) : this.Promise.reject(err);
        }
        const response = promisify(this.Promise, cb);
        const result = response.result;
        if (this._isFull() || this._idle.length) {
          if (this._idle.length) {
            process.nextTick(() => this._pulseQueue());
          }
          if (!this.options.connectionTimeoutMillis) {
            this._pendingQueue.push(new PendingItem(response.callback));
            return result;
          }
          const queueCallback = (err, res, done) => {
            clearTimeout(tid);
            response.callback(err, res, done);
          };
          const pendingItem = new PendingItem(queueCallback);
          const tid = setTimeout(() => {
            removeWhere(this._pendingQueue, (i) => i.callback === queueCallback);
            pendingItem.timedOut = true;
            response.callback(new Error("timeout exceeded when trying to connect"));
          }, this.options.connectionTimeoutMillis);
          if (tid.unref) {
            tid.unref();
          }
          this._pendingQueue.push(pendingItem);
          return result;
        }
        this.newClient(new PendingItem(response.callback));
        return result;
      }
      newClient(pendingItem) {
        const client = new this.Client(this.options);
        this._clients.push(client);
        const idleListener = makeIdleListener(this, client);
        this.log("checking client timeout");
        let tid;
        let timeoutHit = false;
        if (this.options.connectionTimeoutMillis) {
          tid = setTimeout(() => {
            if (client.connection) {
              this.log("ending client due to timeout");
              timeoutHit = true;
              client.connection.stream.destroy();
            } else if (!client.isConnected()) {
              this.log("ending client due to timeout");
              timeoutHit = true;
              client.end();
            }
          }, this.options.connectionTimeoutMillis);
        }
        this.log("connecting new client");
        client.connect((err) => {
          if (tid) {
            clearTimeout(tid);
          }
          client.on("error", idleListener);
          if (err) {
            this.log("client failed to connect", err);
            this._clients = this._clients.filter((c) => c !== client);
            if (timeoutHit) {
              err = new Error("Connection terminated due to connection timeout", { cause: err });
            }
            this._pulseQueue();
            if (!pendingItem.timedOut) {
              pendingItem.callback(err, void 0, NOOP);
            }
          } else {
            this.log("new client connected");
            if (this.options.onConnect) {
              this._promiseTry(() => this.options.onConnect(client)).then(
                () => {
                  this._afterConnect(client, pendingItem, idleListener);
                },
                (hookErr) => {
                  this._clients = this._clients.filter((c) => c !== client);
                  client.end(() => {
                    this._pulseQueue();
                    if (!pendingItem.timedOut) {
                      pendingItem.callback(hookErr, void 0, NOOP);
                    }
                  });
                }
              );
              return;
            }
            return this._afterConnect(client, pendingItem, idleListener);
          }
        });
      }
      _afterConnect(client, pendingItem, idleListener) {
        if (this.options.maxLifetimeSeconds !== 0) {
          const maxLifetimeTimeout = setTimeout(() => {
            this.log("ending client due to expired lifetime");
            this._expired.add(client);
            const idleIndex = this._idle.findIndex((idleItem) => idleItem.client === client);
            if (idleIndex !== -1) {
              this._acquireClient(
                client,
                new PendingItem((err, client2, clientRelease) => clientRelease()),
                idleListener,
                false
              );
            }
          }, this.options.maxLifetimeSeconds * 1e3);
          maxLifetimeTimeout.unref();
          client.once("end", () => clearTimeout(maxLifetimeTimeout));
        }
        return this._acquireClient(client, pendingItem, idleListener, true);
      }
      // acquire a client for a pending work item
      _acquireClient(client, pendingItem, idleListener, isNew) {
        if (isNew) {
          this.emit("connect", client);
        }
        this.emit("acquire", client);
        client.release = this._releaseOnce(client, idleListener);
        client.removeListener("error", idleListener);
        if (!pendingItem.timedOut) {
          if (isNew && this.options.verify) {
            this.options.verify(client, (err) => {
              if (err) {
                client.release(err);
                return pendingItem.callback(err, void 0, NOOP);
              }
              pendingItem.callback(void 0, client, client.release);
            });
          } else {
            pendingItem.callback(void 0, client, client.release);
          }
        } else {
          if (isNew && this.options.verify) {
            this.options.verify(client, client.release);
          } else {
            client.release();
          }
        }
      }
      // returns a function that wraps _release and throws if called more than once
      _releaseOnce(client, idleListener) {
        let released = false;
        return (err) => {
          if (released) {
            throwOnDoubleRelease();
          }
          released = true;
          this._release(client, idleListener, err);
        };
      }
      // release a client back to the poll, include an error
      // to remove it from the pool
      _release(client, idleListener, err) {
        client.on("error", idleListener);
        client._poolUseCount = (client._poolUseCount || 0) + 1;
        this.emit("release", err, client);
        if (err || this.ending || !client._queryable || client._ending || client._poolUseCount >= this.options.maxUses) {
          if (client._poolUseCount >= this.options.maxUses) {
            this.log("remove expended client");
          }
          return this._remove(client, this._pulseQueue.bind(this));
        }
        const isExpired = this._expired.has(client);
        if (isExpired) {
          this.log("remove expired client");
          this._expired.delete(client);
          return this._remove(client, this._pulseQueue.bind(this));
        }
        let tid;
        if (this.options.idleTimeoutMillis && this._isAboveMin()) {
          tid = setTimeout(() => {
            if (this._isAboveMin()) {
              this.log("remove idle client");
              this._remove(client, this._pulseQueue.bind(this));
            }
          }, this.options.idleTimeoutMillis);
          if (this.options.allowExitOnIdle) {
            tid.unref();
          }
        }
        if (this.options.allowExitOnIdle) {
          client.unref();
        }
        this._idle.push(new IdleItem(client, idleListener, tid));
        this._pulseQueue();
      }
      query(text, values, cb) {
        if (typeof text === "function") {
          const response2 = promisify(this.Promise, text);
          setImmediate(function() {
            return response2.callback(new Error("Passing a function as the first parameter to pool.query is not supported"));
          });
          return response2.result;
        }
        if (typeof values === "function") {
          cb = values;
          values = void 0;
        }
        const response = promisify(this.Promise, cb);
        cb = response.callback;
        this.connect((err, client) => {
          if (err) {
            return cb(err);
          }
          let clientReleased = false;
          const onError = (err2) => {
            if (clientReleased) {
              return;
            }
            clientReleased = true;
            client.release(err2);
            cb(err2);
          };
          client.once("error", onError);
          this.log("dispatching query");
          try {
            client.query(text, values, (err2, res) => {
              this.log("query dispatched");
              client.removeListener("error", onError);
              if (clientReleased) {
                return;
              }
              clientReleased = true;
              client.release(err2);
              if (err2) {
                return cb(err2);
              }
              return cb(void 0, res);
            });
          } catch (err2) {
            client.release(err2);
            return cb(err2);
          }
        });
        return response.result;
      }
      end(cb) {
        this.log("ending");
        if (this.ending) {
          const err = new Error("Called end on pool more than once");
          return cb ? cb(err) : this.Promise.reject(err);
        }
        this.ending = true;
        const promised = promisify(this.Promise, cb);
        this._endCallback = promised.callback;
        this._pulseQueue();
        return promised.result;
      }
      get waitingCount() {
        return this._pendingQueue.length;
      }
      get idleCount() {
        return this._idle.length;
      }
      get expiredCount() {
        return this._clients.reduce((acc, client) => acc + (this._expired.has(client) ? 1 : 0), 0);
      }
      get totalCount() {
        return this._clients.length;
      }
    };
    module.exports = Pool2;
  }
});

// ../../node_modules/pg/lib/native/query.js
var require_query2 = __commonJS({
  "../../node_modules/pg/lib/native/query.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var util = __require("util");
    var utils = require_utils();
    var NativeQuery = module.exports = function(config, values, callback) {
      EventEmitter.call(this);
      config = utils.normalizeQueryConfig(config, values, callback);
      this.text = config.text;
      this.values = config.values;
      this.name = config.name;
      this.queryMode = config.queryMode;
      this.callback = config.callback;
      this.state = "new";
      this._arrayMode = config.rowMode === "array";
      this._emitRowEvents = false;
      this.on(
        "newListener",
        function(event) {
          if (event === "row") this._emitRowEvents = true;
        }.bind(this)
      );
    };
    util.inherits(NativeQuery, EventEmitter);
    var errorFieldMap = {
      sqlState: "code",
      statementPosition: "position",
      messagePrimary: "message",
      context: "where",
      schemaName: "schema",
      tableName: "table",
      columnName: "column",
      dataTypeName: "dataType",
      constraintName: "constraint",
      sourceFile: "file",
      sourceLine: "line",
      sourceFunction: "routine"
    };
    NativeQuery.prototype.handleError = function(err) {
      const fields = this.native.pq.resultErrorFields();
      if (fields) {
        for (const key in fields) {
          const normalizedFieldName = errorFieldMap[key] || key;
          err[normalizedFieldName] = fields[key];
        }
      }
      if (this.callback) {
        this.callback(err);
      } else {
        this.emit("error", err);
      }
      this.state = "error";
    };
    NativeQuery.prototype.then = function(onSuccess, onFailure) {
      return this._getPromise().then(onSuccess, onFailure);
    };
    NativeQuery.prototype.catch = function(callback) {
      return this._getPromise().catch(callback);
    };
    NativeQuery.prototype._getPromise = function() {
      if (this._promise) return this._promise;
      this._promise = new Promise(
        function(resolve3, reject) {
          this._once("end", resolve3);
          this._once("error", reject);
        }.bind(this)
      );
      return this._promise;
    };
    NativeQuery.prototype.submit = function(client) {
      this.state = "running";
      const self = this;
      this.native = client.native;
      client.native.arrayMode = this._arrayMode;
      let after = function(err, rows, results) {
        client.native.arrayMode = false;
        setImmediate(function() {
          self.emit("_done");
        });
        if (err) {
          return self.handleError(err);
        }
        if (self._emitRowEvents) {
          if (results.length > 1) {
            rows.forEach((rowOfRows, i) => {
              rowOfRows.forEach((row) => {
                self.emit("row", row, results[i]);
              });
            });
          } else {
            rows.forEach(function(row) {
              self.emit("row", row, results);
            });
          }
        }
        self.state = "end";
        self.emit("end", results);
        if (self.callback) {
          self.callback(null, results);
        }
      };
      if (process.domain) {
        after = process.domain.bind(after);
      }
      if (this.name) {
        if (this.name.length > 63) {
          console.error("Warning! Postgres only supports 63 characters for query names.");
          console.error("You supplied %s (%s)", this.name, this.name.length);
          console.error("This can cause conflicts and silent errors executing queries");
        }
        const values = (this.values || []).map(utils.prepareValue);
        if (client.namedQueries[this.name]) {
          if (this.text && client.namedQueries[this.name] !== this.text) {
            const err = new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
            return after(err);
          }
          return client.native.execute(this.name, values, after);
        }
        return client.native.prepare(this.name, this.text, values.length, function(err) {
          if (err) return after(err);
          client.namedQueries[self.name] = self.text;
          return self.native.execute(self.name, values, after);
        });
      } else if (this.values) {
        if (!Array.isArray(this.values)) {
          const err = new Error("Query values must be an array");
          return after(err);
        }
        const vals = this.values.map(utils.prepareValue);
        client.native.query(this.text, vals, after);
      } else if (this.queryMode === "extended") {
        client.native.query(this.text, [], after);
      } else {
        client.native.query(this.text, after);
      }
    };
  }
});

// ../../node_modules/pg/lib/native/client.js
var require_client2 = __commonJS({
  "../../node_modules/pg/lib/native/client.js"(exports, module) {
    var nodeUtils = __require("util");
    var Native;
    try {
      Native = __require("pg-native");
    } catch (e) {
      throw e;
    }
    var TypeOverrides2 = require_type_overrides();
    var EventEmitter = __require("events").EventEmitter;
    var util = __require("util");
    var ConnectionParameters = require_connection_parameters();
    var NativeQuery = require_query2();
    var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."
    );
    var Client2 = module.exports = function(config) {
      EventEmitter.call(this);
      config = config || {};
      this._Promise = config.Promise || global.Promise;
      this._types = new TypeOverrides2(config.types);
      this.native = new Native({
        types: this._types
      });
      this._queryQueue = [];
      this._ending = false;
      this._connecting = false;
      this._connected = false;
      this._queryable = true;
      const cp = this.connectionParameters = new ConnectionParameters(config);
      if (config.nativeConnectionString) cp.nativeConnectionString = config.nativeConnectionString;
      this.user = cp.user;
      Object.defineProperty(this, "password", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: cp.password
      });
      this.database = cp.database;
      this.host = cp.host;
      this.port = cp.port;
      this.namedQueries = {};
    };
    Client2.Query = NativeQuery;
    util.inherits(Client2, EventEmitter);
    Client2.prototype._errorAllQueries = function(err) {
      const enqueueError = (query) => {
        process.nextTick(() => {
          query.native = this.native;
          query.handleError(err);
        });
      };
      if (this._hasActiveQuery()) {
        enqueueError(this._activeQuery);
        this._activeQuery = null;
      }
      this._queryQueue.forEach(enqueueError);
      this._queryQueue.length = 0;
    };
    Client2.prototype._connect = function(cb) {
      const self = this;
      if (this._connecting) {
        process.nextTick(() => cb(new Error("Client has already been connected. You cannot reuse a client.")));
        return;
      }
      this._connecting = true;
      this.connectionParameters.getLibpqConnectionString(function(err, conString) {
        if (self.connectionParameters.nativeConnectionString) conString = self.connectionParameters.nativeConnectionString;
        if (err) return cb(err);
        self.native.connect(conString, function(err2) {
          if (err2) {
            self.native.end();
            return cb(err2);
          }
          self._connected = true;
          self.native.on("error", function(err3) {
            self._queryable = false;
            self._errorAllQueries(err3);
            self.emit("error", err3);
          });
          self.native.on("notification", function(msg) {
            self.emit("notification", {
              channel: msg.relname,
              payload: msg.extra
            });
          });
          self.emit("connect");
          self._pulseQueryQueue(true);
          cb(null, this);
        });
      });
    };
    Client2.prototype.connect = function(callback) {
      if (callback) {
        this._connect(callback);
        return;
      }
      return new this._Promise((resolve3, reject) => {
        this._connect((error) => {
          if (error) {
            reject(error);
          } else {
            resolve3(this);
          }
        });
      });
    };
    Client2.prototype.query = function(config, values, callback) {
      let query;
      let result;
      let readTimeout;
      let readTimeoutTimer;
      let queryCallback;
      if (config === null || config === void 0) {
        throw new TypeError("Client was passed a null or undefined query");
      } else if (typeof config.submit === "function") {
        readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        result = query = config;
        if (typeof values === "function") {
          config.callback = values;
        }
      } else {
        readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        query = new NativeQuery(config, values, callback);
        if (!query.callback) {
          let resolveOut, rejectOut;
          result = new this._Promise((resolve3, reject) => {
            resolveOut = resolve3;
            rejectOut = reject;
          }).catch((err) => {
            Error.captureStackTrace(err);
            throw err;
          });
          query.callback = (err, res) => err ? rejectOut(err) : resolveOut(res);
        }
      }
      if (readTimeout) {
        queryCallback = query.callback || (() => {
        });
        readTimeoutTimer = setTimeout(() => {
          const error = new Error("Query read timeout");
          process.nextTick(() => {
            query.handleError(error, this.connection);
          });
          queryCallback(error);
          query.callback = () => {
          };
          const index = this._queryQueue.indexOf(query);
          if (index > -1) {
            this._queryQueue.splice(index, 1);
          }
          this._pulseQueryQueue();
        }, readTimeout);
        query.callback = (err, res) => {
          clearTimeout(readTimeoutTimer);
          queryCallback(err, res);
        };
      }
      if (!this._queryable) {
        query.native = this.native;
        process.nextTick(() => {
          query.handleError(new Error("Client has encountered a connection error and is not queryable"));
        });
        return result;
      }
      if (this._ending) {
        query.native = this.native;
        process.nextTick(() => {
          query.handleError(new Error("Client was closed and is not queryable"));
        });
        return result;
      }
      if (this._queryQueue.length > 0) {
        queryQueueLengthDeprecationNotice();
      }
      this._queryQueue.push(query);
      this._pulseQueryQueue();
      return result;
    };
    Client2.prototype.end = function(cb) {
      const self = this;
      this._ending = true;
      if (!this._connected) {
        this.once("connect", this.end.bind(this, cb));
      }
      let result;
      if (!cb) {
        result = new this._Promise(function(resolve3, reject) {
          cb = (err) => err ? reject(err) : resolve3();
        });
      }
      this.native.end(function() {
        self._connected = false;
        self._errorAllQueries(new Error("Connection terminated"));
        process.nextTick(() => {
          self.emit("end");
          if (cb) cb();
        });
      });
      return result;
    };
    Client2.prototype._hasActiveQuery = function() {
      return this._activeQuery && this._activeQuery.state !== "error" && this._activeQuery.state !== "end";
    };
    Client2.prototype._pulseQueryQueue = function(initialConnection) {
      if (!this._connected) {
        return;
      }
      if (this._hasActiveQuery()) {
        return;
      }
      const query = this._queryQueue.shift();
      if (!query) {
        if (!initialConnection) {
          this.emit("drain");
        }
        return;
      }
      this._activeQuery = query;
      query.submit(this);
      const self = this;
      query.once("_done", function() {
        self._pulseQueryQueue();
      });
    };
    Client2.prototype.cancel = function(query) {
      if (this._activeQuery === query) {
        this.native.cancel(function() {
        });
      } else if (this._queryQueue.indexOf(query) !== -1) {
        this._queryQueue.splice(this._queryQueue.indexOf(query), 1);
      }
    };
    Client2.prototype.ref = function() {
    };
    Client2.prototype.unref = function() {
    };
    Client2.prototype.setTypeParser = function(oid, format, parseFn) {
      return this._types.setTypeParser(oid, format, parseFn);
    };
    Client2.prototype.getTypeParser = function(oid, format) {
      return this._types.getTypeParser(oid, format);
    };
    Client2.prototype.isConnected = function() {
      return this._connected;
    };
  }
});

// ../../node_modules/pg/lib/native/index.js
var require_native = __commonJS({
  "../../node_modules/pg/lib/native/index.js"(exports, module) {
    "use strict";
    module.exports = require_client2();
  }
});

// ../../node_modules/pg/lib/index.js
var require_lib2 = __commonJS({
  "../../node_modules/pg/lib/index.js"(exports, module) {
    "use strict";
    var Client2 = require_client();
    var defaults2 = require_defaults();
    var Connection2 = require_connection();
    var Result2 = require_result();
    var utils = require_utils();
    var Pool2 = require_pg_pool();
    var TypeOverrides2 = require_type_overrides();
    var { DatabaseError: DatabaseError2 } = require_dist();
    var { escapeIdentifier: escapeIdentifier2, escapeLiteral: escapeLiteral2 } = require_utils();
    var poolFactory = (Client3) => {
      return class BoundPool extends Pool2 {
        constructor(options) {
          super(options, Client3);
        }
      };
    };
    var PG = function(clientConstructor2) {
      this.defaults = defaults2;
      this.Client = clientConstructor2;
      this.Query = this.Client.Query;
      this.Pool = poolFactory(this.Client);
      this._pools = [];
      this.Connection = Connection2;
      this.types = require_pg_types();
      this.DatabaseError = DatabaseError2;
      this.TypeOverrides = TypeOverrides2;
      this.escapeIdentifier = escapeIdentifier2;
      this.escapeLiteral = escapeLiteral2;
      this.Result = Result2;
      this.utils = utils;
    };
    var clientConstructor = Client2;
    var forceNative = false;
    try {
      forceNative = !!process.env.NODE_PG_FORCE_NATIVE;
    } catch {
    }
    if (forceNative) {
      clientConstructor = require_native();
    }
    module.exports = new PG(clientConstructor);
    Object.defineProperty(module.exports, "native", {
      configurable: true,
      enumerable: false,
      get() {
        let native = null;
        try {
          native = new PG(require_native());
        } catch (err) {
          if (err.code !== "MODULE_NOT_FOUND") {
            throw err;
          }
        }
        Object.defineProperty(module.exports, "native", {
          value: native
        });
        return native;
      }
    });
  }
});

// ../../node_modules/pg/esm/index.mjs
var esm_exports = {};
__export(esm_exports, {
  Client: () => Client,
  Connection: () => Connection,
  DatabaseError: () => DatabaseError,
  Pool: () => Pool,
  Query: () => Query,
  Result: () => Result,
  TypeOverrides: () => TypeOverrides,
  default: () => esm_default,
  defaults: () => defaults,
  escapeIdentifier: () => escapeIdentifier,
  escapeLiteral: () => escapeLiteral,
  types: () => types
});
var import_lib, Client, Pool, Connection, types, Query, DatabaseError, escapeIdentifier, escapeLiteral, Result, TypeOverrides, defaults, esm_default;
var init_esm = __esm({
  "../../node_modules/pg/esm/index.mjs"() {
    import_lib = __toESM(require_lib2(), 1);
    Client = import_lib.default.Client;
    Pool = import_lib.default.Pool;
    Connection = import_lib.default.Connection;
    types = import_lib.default.types;
    Query = import_lib.default.Query;
    DatabaseError = import_lib.default.DatabaseError;
    escapeIdentifier = import_lib.default.escapeIdentifier;
    escapeLiteral = import_lib.default.escapeLiteral;
    Result = import_lib.default.Result;
    TypeOverrides = import_lib.default.TypeOverrides;
    defaults = import_lib.default.defaults;
    esm_default = import_lib.default;
  }
});

// ../../libs/generic/memory/src/mem0-connection.ts
var mem0_connection_exports = {};
__export(mem0_connection_exports, {
  connectionString: () => connectionString,
  pgClientFields: () => pgClientFields,
  pgFields: () => pgFields
});
async function connectionString() {
  return memoryHost().getAdminUrl();
}
async function pgFields() {
  const url = await connectionString();
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    dbname: u.pathname.replace(/^\//, "") || memoryHost().defaultDbName || "postgres"
  };
}
async function pgClientFields() {
  const f = await pgFields();
  return {
    host: f.host,
    port: f.port,
    user: f.user,
    password: f.password,
    database: f.dbname
  };
}
var init_mem0_connection = __esm({
  "../../libs/generic/memory/src/mem0-connection.ts"() {
    "use strict";
    init_config();
  }
});

// bin/embed-sidecar.ts
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ../../packages/operator-core/lib/memory/embed-sidecar-server.ts
import * as http from "node:http";

// ../../libs/generic/memory/src/index.ts
init_config();

// ../../libs/generic/memory/src/canonical-store.ts
init_esm();
function safeKey(k) {
  return k.replace(/[^a-zA-Z0-9_]/g, "");
}
function isMissingIterativeScanParameter(error) {
  const candidate = error;
  const code = candidate?.code;
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  return code === "42704" || /unrecognized configuration parameter[\s\S]*hnsw\.iterative_scan/i.test(message);
}
var ENTITY_STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "and",
  "or",
  "but",
  "so",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "with",
  "as",
  "by",
  "from",
  "just",
  "else",
  "before",
  "after",
  "nothing",
  "something",
  "anything",
  "one",
  "mid",
  "re",
  "ve",
  "ll",
  "no",
  "not",
  "than",
  "then",
  "up",
  "out",
  "off",
  "over",
  "per",
  "via",
  "their",
  "there",
  "here",
  "when",
  "while",
  "into",
  "onto",
  "about",
  "above",
  "below",
  "against",
  "through",
  "during",
  "without",
  "between",
  "among",
  "because",
  "although",
  "though",
  "if",
  "until",
  "unless",
  "whether",
  "which",
  "who",
  "whom",
  "whose",
  "what",
  "where",
  "why",
  "how",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must"
]);
var ENTITY_CLAUSE_WORDS = /* @__PURE__ */ new Set([
  "against",
  "and",
  "or",
  "but",
  "so",
  "because",
  "although",
  "though",
  "if",
  "when",
  "while",
  "until",
  "unless",
  "then",
  "than",
  "whether",
  "which",
  "who",
  "whom",
  "whose",
  "what",
  "where",
  "why",
  "how",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must"
]);
var ENTITY_NOUN_GERUNDS = /* @__PURE__ */ new Set([
  "embedding",
  "building",
  "testing",
  "training",
  "routing",
  "running",
  "linking",
  "indexing",
  "caching",
  "logging",
  "parsing",
  "streaming",
  "rendering",
  "deploying",
  "releasing",
  "scoping",
  "staging",
  "handling",
  "loading",
  "writing",
  "reading",
  "searching",
  "matching",
  "ranking",
  "federating",
  "migrating",
  "processing",
  "querying",
  "fetching",
  "syncing",
  "spawning",
  "checkpointing",
  "compacting",
  "orchestrating",
  "scheduling",
  "validating",
  "reviewing",
  "working",
  "waiting",
  "passing",
  "failing"
]);
var ENTITY_VAGUE_LEADERS = /* @__PURE__ */ new Set([
  "actual",
  "apparent",
  "different",
  "entire",
  "false",
  "genuine",
  "likely",
  "new",
  "only",
  "other",
  "possible",
  "potential",
  "prior",
  "previous",
  "real",
  "same",
  "single",
  "true",
  "whole"
]);
var ENTITY_ARTIFACT_PUNCTUATION = /[\`"|()[\]{}+,;:!?<>\u2014\u2013]/;
var ENTITY_NOMINALIZATION = /(?:tion|sion|ment|ance|ence|ity|ness|al)$/;
var ENTITY_PLURAL = /(?:s|es|ies)$/;
function normalizeEntityWord(word) {
  return word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}
function isLowQualityCompoundEntity(text) {
  let t = String(text ?? "").trim().toLowerCase();
  if (!t) return true;
  t = t.replace(/^(?:the|a|an)\s+/, "");
  const words = t.split(/\s+/).filter(Boolean).map(normalizeEntityWord).filter(Boolean);
  if (words.length < 2) return true;
  if (ENTITY_STOPWORDS.has(words[0]) || ENTITY_STOPWORDS.has(words[words.length - 1])) return true;
  if (ENTITY_ARTIFACT_PUNCTUATION.test(t)) return true;
  if (words.some((word) => ENTITY_CLAUSE_WORDS.has(word))) return true;
  if (words.length >= 3 && words.some((word) => /['\u2019]s$/.test(word))) return true;
  const first = words[0];
  if (first.length >= 8 && first.endsWith("ing") && !ENTITY_NOUN_GERUNDS.has(first)) return true;
  const hasNominalizedWord = words.slice(1).some(
    (word) => word.length >= 5 && ENTITY_NOMINALIZATION.test(word)
  );
  const lastWord = words[words.length - 1];
  const hasPluralTail = ENTITY_PLURAL.test(lastWord) && !/(?:ss|us|is)$/.test(lastWord);
  if (words.length >= 3 && ENTITY_VAGUE_LEADERS.has(first) && hasNominalizedWord && hasPluralTail) {
    return true;
  }
  const hasContent = words.some((w) => w.length >= 3 && !ENTITY_STOPWORDS.has(w) && /[a-z]/.test(w));
  return !hasContent;
}
function entityFilterEnabled() {
  return process.env.PAPERCUSP_MEMORY_ENTITY_FILTER !== "off";
}
var LEXICAL_MAX_TOKENS = 32;
function lexicalTokens(query) {
  const whole = query.toLowerCase().split(/[^a-z0-9_-]+/).filter((t) => t.length >= 2);
  const subs = [];
  for (const t of whole) {
    if (!/[_-]/.test(t)) continue;
    for (const s of t.split(/[_-]+/)) if (s.length >= 2) subs.push(s);
  }
  return [.../* @__PURE__ */ new Set([...whole, ...subs])].slice(0, LEXICAL_MAX_TOKENS);
}
function toVectorLiteral(v) {
  return `[${v.join(",")}]`;
}
function storeKindCond(alias, kind) {
  const has = `${alias}payload ? 'entityType'`;
  return kind === "entity" ? has : `NOT (${has})`;
}
function splitTemporalControls(filters) {
  if (!filters) return { temporal: { includeSuperseded: false }, rest: void 0 };
  const { as_of, include_superseded, ...rest } = filters;
  const hasAsOf = as_of !== void 0 && as_of !== null;
  const asOfMs = typeof as_of === "string" || typeof as_of === "number" ? new Date(as_of).getTime() : NaN;
  if (hasAsOf && !Number.isFinite(asOfMs)) {
    throw new RangeError("as_of must be a parseable timestamp");
  }
  return {
    temporal: {
      ...hasAsOf ? { asOf: new Date(asOfMs).toISOString() } : {},
      includeSuperseded: include_superseded === true || include_superseded === 1 || include_superseded === "1" || include_superseded === "true"
    },
    rest
  };
}
function validityCond(alias, temporal, params, nextIdx) {
  if (temporal.asOf !== void 0) {
    const i = nextIdx();
    params.push(temporal.asOf);
    return `COALESCE(${alias}valid_at, ${alias}created_at) <= $${i}::timestamptz AND (${alias}invalid_at IS NULL OR ${alias}invalid_at > $${i}::timestamptz)`;
  }
  if (temporal.includeSuperseded) return null;
  return `(${alias}invalid_at IS NULL OR ${alias}invalid_at > now())`;
}
function foldValidity(payload, row, temporal) {
  const validAt = row.valid_at ?? null;
  const invalidAt = row.invalid_at ?? null;
  const supersededBy = row.superseded_by ?? null;
  if (validAt === null && invalidAt === null && supersededBy === null && temporal.asOf === void 0) {
    return payload;
  }
  const refMs = temporal.asOf !== void 0 ? new Date(temporal.asOf).getTime() : Date.now();
  const invalidMs = invalidAt !== null ? new Date(String(invalidAt)).getTime() : null;
  return {
    ...payload,
    validity: {
      valid_at: validAt,
      invalid_at: invalidAt,
      superseded_by: supersededBy,
      status: invalidMs !== null && invalidMs <= refMs ? "superseded" : "current"
    }
  };
}
var CanonicalVectorStore = class {
  cfg;
  /** 'entity' when mem0 constructed this instance as its entity store. */
  storeKind;
  userId = "";
  // A small Pool, not a single Client: concurrent callers (parallel
  // memory writes, the bench's concurrent seeding) interleave queries,
  // which a lone pg.Client only tolerates via a deprecated internal
  // queue (removed in pg@9). Connection errors surface per query and
  // retry naturally \u2014 no poison-cache to manage.
  pool = null;
  constructor(config) {
    this.cfg = config;
    this.storeKind = config.collectionName?.endsWith("_entities") ? "entity" : "memory";
  }
  async getClient() {
    if (!this.pool) {
      this.pool = new Pool({
        host: this.cfg.host,
        port: this.cfg.port,
        user: this.cfg.user,
        password: this.cfg.password,
        database: this.cfg.dbname,
        max: 5
      });
      this.pool.on("error", () => {
      });
    }
    return this.pool;
  }
  /**
   * Whether this server understands `hnsw.iterative_scan` (pgvector >= 0.8).
   * Probed once per store and cached when the result is stable. An older build
   * rejects the GUC with `unrecognized configuration parameter`, so that
   * permanent capability answer is cached. A transient connection failure must
   * not poison the process: failing open for that call (a narrower result)
   * beats failing search entirely, and the next call gets another chance.
   */
  iterativeScanSupport = null;
  probeIterativeScan(pool) {
    if (!this.iterativeScanSupport) {
      let probe;
      probe = (async () => {
        let conn = null;
        try {
          conn = await pool.connect();
          await conn.query("BEGIN");
          await conn.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
          return true;
        } catch (error) {
          const permanentUnsupported = isMissingIterativeScanParameter(error);
          console.warn(
            permanentUnsupported ? "[memory] server does not support hnsw.iterative_scan; using the legacy capped scan" : "[memory] capability probe failed transiently; using the legacy capped scan for this call and will retry"
          );
          if (!permanentUnsupported && this.iterativeScanSupport === probe) {
            this.iterativeScanSupport = null;
          }
          return false;
        } finally {
          if (conn) {
            try {
              await conn.query("ROLLBACK");
            } catch {
            }
            conn.release();
          }
        }
      })();
      this.iterativeScanSupport = probe;
    }
    return this.iterativeScanSupport;
  }
  /**
   * Run the vector search with HNSW *iterative* scanning enabled.
   *
   * Why this is required rather than a tuning nicety: the scope predicate
   * (`c.payload->>'user_id'`) lives on the JOINED canonical table, so
   * Postgres can only apply it AFTER the approximate index scan has already
   * chosen its candidate set. Without iterative scanning that scan stops at
   * `hnsw.ef_search` (default 40) candidates, and any scope whose rows are
   * not among those 40 silently yields FEWER rows than LIMIT \u2014 with no error
   * and no signal to the caller. Measured on the live store 2026-08-02
   * (EI-19386910150607131): a `LIMIT 12` scoped pull returned **0 rows**
   * against **18,510 eligible** ones. Iterative scanning keeps scanning
   * until LIMIT is satisfied, bounded by `hnsw.max_scan_tuples` (default
   * 20k), so a starved scope degrades to "fewer than asked" instead of zero.
   *
   * `relaxed_order` over `strict_order`: measured identical top-12 and
   * identical worst score on the live store at ~4x the speed (8.6ms vs
   * 35.2ms), and every caller re-ranks downstream anyway.
   */
  async runVectorSearch(pool, sql, params) {
    if (!await this.probeIterativeScan(pool)) return pool.query(sql, params);
    const conn = await pool.connect();
    try {
      await conn.query("BEGIN READ ONLY");
      await conn.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      const res = await conn.query(sql, params);
      await conn.query("COMMIT");
      return res;
    } catch (err) {
      try {
        await conn.query("ROLLBACK");
      } catch {
      }
      throw err;
    } finally {
      conn.release();
    }
  }
  async initialize() {
  }
  /**
   * Close the cached PG pool. The mem0 client is torn down + rebuilt on a
   * TTL (1h) and on `invalidateMemoryClient()`; each rebuild constructs a fresh
   * store via the patched VectorStoreFactory. Without this, the prior store's
   * pool is orphaned \u2014 a slow connection leak against embedded PG over a
   * long-running operator. Idempotent and tolerant of a never-connected store.
   */
  async dispose() {
    const p = this.pool;
    this.pool = null;
    if (!p) return;
    try {
      await p.end();
    } catch {
    }
  }
  async insert(vectors, ids, payloads) {
    if (vectors.length !== ids.length || ids.length !== payloads.length) {
      throw new Error("CanonicalVectorStore.insert: vectors/ids/payloads length mismatch");
    }
    const client = await this.getClient();
    const vecTable = `${this.cfg.schema}.${this.cfg.vecTable}`;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const vec = vectors[i];
      const { validity: _validity, ...payload } = payloads[i] ?? {};
      if (this.storeKind === "entity" && entityFilterEnabled() && payload.entityType === "COMPOUND" && isLowQualityCompoundEntity(String(payload.data ?? ""))) {
        continue;
      }
      if (vec.length !== this.cfg.embeddingModelDims) {
        throw new Error(
          `CanonicalVectorStore.insert: vector dim ${vec.length} !== expected ${this.cfg.embeddingModelDims}`
        );
      }
      await client.query(
        `INSERT INTO ${this.cfg.schema}.memory_canonical (id, payload, created_at, updated_at)
         VALUES ($1, $2::jsonb, now(), now())
         ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
        [id, JSON.stringify(payload)]
      );
      await client.query(
        `INSERT INTO ${vecTable} (memory_id, vector, embedded_at)
         VALUES ($1, $2::vector, now())
         ON CONFLICT (memory_id) DO UPDATE SET vector = EXCLUDED.vector, embedded_at = now()`,
        [id, toVectorLiteral(vec)]
      );
    }
  }
  async search(query, topK = 5, filters) {
    const client = await this.getClient();
    const vecTable = `${this.cfg.schema}.${this.cfg.vecTable}`;
    const { temporal, rest } = splitTemporalControls(filters);
    const conds = [storeKindCond("c.", this.storeKind), `c.state != 'archived'`];
    const params = [toVectorLiteral(query), topK];
    let idx = 3;
    if (rest) {
      for (const [key, value] of Object.entries(rest)) {
        if (value === void 0 || value === null) continue;
        if (typeof value !== "string" && typeof value !== "number") continue;
        conds.push(`c.payload->>'${safeKey(key)}' = $${idx}`);
        params.push(String(value));
        idx++;
      }
    }
    if (this.storeKind === "memory") {
      const vCond = validityCond("c.", temporal, params, () => idx++);
      if (vCond) conds.push(vCond);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const sql = `
      SELECT c.id, c.payload, c.valid_at, c.invalid_at, c.superseded_by,
             1 - (v.vector <=> $1::vector) AS score
      FROM ${vecTable} v
      JOIN ${this.cfg.schema}.memory_canonical c ON c.id = v.memory_id
      ${where}
      ORDER BY v.vector <=> $1::vector
      LIMIT $2
    `;
    const res = await this.runVectorSearch(client, sql, params);
    return res.rows.map(
      (r) => ({
        id: r.id,
        payload: this.storeKind === "memory" ? foldValidity(r.payload, r, temporal) : r.payload,
        score: Number(r.score)
      })
    );
  }
  // mem0 calls this for BM25 hybrid scoring. Returning null tells mem0
  // to fall back to pure semantic; we can wire postgres FTS later if
  // the quality gap is real.
  async keywordSearch(_query, _topK, _filters) {
    return null;
  }
  /**
   * EMBED-FREE lexical search \u2014 originally the degraded-path fallback behind
   * `MemoryBackend.searchLexical` (WI-4214); since P-002 of
   * memory-pg-lexical-own-injection-2026-07-13 also the FIRST-CLASS lexical
   * leg of the `hybrid-pg` backend, brought to scoring parity with the
   * claude-file leg that benched best on exact-identifier recall. Pulls
   * candidates matching ANY query token (ILIKE) across the payload's `name`,
   * `description`, and `data` fields, then field-weight scores in JS \u2014 per
   * token: name hit ×3, else description hit ×2, else data hit ×1,
   * normalized 0..1 by tokens×3. NOT on the cosine scale; ordering only.
   * Reuses the store-kind + archived guards and the post-filter semantics of
   * search()/list(). Bounded: \u2264 LEXICAL_MAX_TOKENS tokens, candidates
   * capped, no vec-table join.
   */
  async lexicalSearch(query, topK = 5, filters) {
    const tokens = lexicalTokens(query);
    if (tokens.length === 0) return [];
    const client = await this.getClient();
    const { temporal, rest } = splitTemporalControls(filters);
    const conds = [storeKindCond("", this.storeKind), `state != 'archived'`];
    const params = [];
    let idx = 1;
    if (rest) {
      for (const [key, value] of Object.entries(rest)) {
        if (value === void 0 || value === null) continue;
        if (typeof value !== "string" && typeof value !== "number") continue;
        conds.push(`payload->>'${safeKey(key)}' = $${idx}`);
        params.push(String(value));
        idx++;
      }
    }
    if (this.storeKind === "memory") {
      const vCond = validityCond("", temporal, params, () => idx++);
      if (vCond) conds.push(vCond);
    }
    const scoreTerms = [];
    const matchTerms = [];
    for (const t of tokens) {
      params.push(`%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const p = `$${idx++}`;
      scoreTerms.push(
        `CASE WHEN nm ILIKE ${p} THEN 3 WHEN ds ILIKE ${p} THEN 2 WHEN dt ILIKE ${p} THEN 1 ELSE 0 END`
      );
      matchTerms.push(`nm ILIKE ${p} OR ds ILIKE ${p} OR dt ILIKE ${p}`);
    }
    const rawScore = scoreTerms.join(" + ");
    params.push(topK);
    const res = await client.query(
      `SELECT id, payload, valid_at, invalid_at, superseded_by,
              (${rawScore})::float AS lex_raw
       FROM (
         SELECT id, payload, valid_at, invalid_at, superseded_by, created_at,
                payload->>'name' AS nm,
                payload->>'description' AS ds,
                payload->>'data' AS dt
         FROM ${this.cfg.schema}.memory_canonical
         WHERE ${conds.join(" AND ")}
         OFFSET 0
       ) c
       WHERE (${matchTerms.join(" OR ")})
       ORDER BY lex_raw DESC, created_at DESC
       LIMIT $${idx}`,
      params
    );
    return res.rows.map(
      (r) => ({
        id: r.id,
        payload: this.storeKind === "memory" ? foldValidity(r.payload, r, temporal) : r.payload,
        score: Number(r.lex_raw) / (tokens.length * 3)
      })
    );
  }
  async get(id) {
    const client = await this.getClient();
    const res = await client.query(
      `SELECT id, payload, valid_at, invalid_at, superseded_by
         FROM ${this.cfg.schema}.memory_canonical WHERE id = $1`,
      [id]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      payload: this.storeKind === "memory" ? foldValidity(row.payload, row, { includeSuperseded: false }) : row.payload
    };
  }
  async update(id, vector, payload) {
    if (vector.length !== this.cfg.embeddingModelDims) {
      throw new Error(
        `CanonicalVectorStore.update: vector dim ${vector.length} !== expected ${this.cfg.embeddingModelDims}`
      );
    }
    const client = await this.getClient();
    const vecTable = `${this.cfg.schema}.${this.cfg.vecTable}`;
    const { validity: _validity, ...nextPayload } = payload ?? {};
    await client.query(
      `UPDATE ${this.cfg.schema}.memory_canonical
          SET payload = payload || $2::jsonb, updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(nextPayload)]
    );
    await client.query(
      `INSERT INTO ${vecTable} (memory_id, vector, embedded_at)
       VALUES ($1, $2::vector, now())
       ON CONFLICT (memory_id) DO UPDATE SET vector = EXCLUDED.vector, embedded_at = now()`,
      [id, toVectorLiteral(vector)]
    );
  }
  /**
   * Patch a memory row's metadata WITHOUT re-embedding \u2014 a shallow merge of
   * `patch` into the existing `payload` jsonb (`payload || patch`, so patch keys
   * override and unspecified keys are preserved). This is the store half of the
   * neutral `MemoryBackend.update({ metadata })` path (mem0's OSS text-only
   * update can't touch metadata). VEC-SAFE: the embedding lives in the separate
   * `memory_vec_*` tables keyed by `memory_id`, untouched here \u2014 scope (`user_id`),
   * `workspace_id`, `kind`, anchors etc. are filter/display fields, not embedded,
   * so a metadata fix needs no re-embed. Guarded to MEMORY rows (never an mem0
   * entity-linking row, which carries `entityType`). Returns whether a row matched
   * (false = unknown id \u2192 the not-found contract the backend surfaces).
   */
  async updatePayload(id, patch) {
    if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) return false;
    const { validity: _validity, ...rest } = patch;
    const client = await this.getClient();
    const res = await client.query(
      `UPDATE ${this.cfg.schema}.memory_canonical
          SET payload = payload || $2::jsonb, updated_at = now()
        WHERE id = $1 AND NOT (payload ? 'entityType')`,
      [id, JSON.stringify(rest)]
    );
    return (res.rowCount ?? 0) > 0;
  }
  /**
   * Close a memory row's validity window \u2014 the store half of soft-forget and
   * supersession (temporal P-002/P-004). VEC-SAFE: a column-only UPDATE, the
   * embedding is never touched (validity is not embedded), so invalidation
   * costs no re-embed. First-wins idempotence: only an OPEN row
   * (`invalid_at IS NULL`) matches, so a repeat call or a racing peer is a
   * no-op returning false \u2014 the first closer's window (and superseded_by)
   * stands. Entity rows are exempt (mem0's lifecycle). Returns whether an
   * open memory row was closed.
   */
  async invalidate(id, opts = {}) {
    const client = await this.getClient();
    const res = await client.query(
      `UPDATE ${this.cfg.schema}.memory_canonical
          SET invalid_at = COALESCE($2::timestamptz, now()),
              superseded_by = $3::uuid,
              updated_at = now()
        WHERE id = $1 AND NOT (payload ? 'entityType') AND invalid_at IS NULL`,
      [id, opts.at ?? null, opts.supersededBy ?? null]
    );
    return (res.rowCount ?? 0) > 0;
  }
  async delete(id) {
    const client = await this.getClient();
    await client.query(`DELETE FROM ${this.cfg.schema}.memory_canonical WHERE id = $1`, [id]);
  }
  /**
   * mem0 calls this for collection-wide reset (deleteAll, reset). The
   * canonical table is SHARED across every user + harness (scope lives in
   * `payload.user_id`), so an unscoped `DELETE` here would wipe EVERYONE's
   * memories \u2014 a multi-tenant data-loss footgun. We scope the reset to the
   * store's current `userId` instead: cascade clears that user's vec rows in
   * both model tables, and other scopes are untouched. With no active scope we
   * refuse rather than nuke the shared table.
   */
  async deleteCol() {
    if (!this.userId) {
      console.warn(
        "[memory] CanonicalVectorStore.deleteCol called with no userId scope \u2014 refusing to wipe the shared memory_canonical table."
      );
      return;
    }
    const client = await this.getClient();
    await client.query(
      `DELETE FROM ${this.cfg.schema}.memory_canonical WHERE payload->>'user_id' = $1`,
      [this.userId]
    );
  }
  /**
   * List canonical rows matching the filter. Crucially this does NOT
   * gate on vec-table presence \u2014 entries written under another
   * embedder mode are real memories the user expects to see and
   * edit/delete. (Semantic SEARCH naturally requires a vector in the
   * active model; LIST does not.)
   */
  async list(filters, topK = 100) {
    const client = await this.getClient();
    const { temporal, rest } = splitTemporalControls(filters);
    const conds = [storeKindCond("", this.storeKind), `state != 'archived'`];
    const params = [];
    let idx = 1;
    if (rest) {
      for (const [key, value] of Object.entries(rest)) {
        if (value === void 0 || value === null) continue;
        if (typeof value !== "string" && typeof value !== "number") continue;
        conds.push(`payload->>'${safeKey(key)}' = $${idx}`);
        params.push(String(value));
        idx++;
      }
    }
    if (this.storeKind === "memory") {
      const vCond = validityCond("", temporal, params, () => idx++);
      if (vCond) conds.push(vCond);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const listSql = `
      SELECT id, payload, valid_at, invalid_at, superseded_by
      FROM ${this.cfg.schema}.memory_canonical
      ${where}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `;
    const countSql = `
      SELECT COUNT(*)::bigint AS n
      FROM ${this.cfg.schema}.memory_canonical
      ${where}
    `;
    const [listRes, countRes] = await Promise.all([
      client.query(listSql, [...params, topK]),
      client.query(countSql, params)
    ]);
    const rows = listRes.rows.map(
      (r) => ({
        id: r.id,
        payload: this.storeKind === "memory" ? foldValidity(r.payload, r, temporal) : r.payload
      })
    );
    return [rows, Number(countRes.rows[0].n)];
  }
  async getUserId() {
    return this.userId;
  }
  async setUserId(userId) {
    this.userId = userId;
  }
};

// ../../libs/generic/memory/src/mem0-client.ts
init_config();

// ../../libs/generic/memory/src/embed-coalesce.ts
import { createHash } from "node:crypto";
function coalesceEmbedFn(fn, opts = {}) {
  return coalesceEmbedFnWithStats(fn, opts).embed;
}
function coalesceEmbedFnWithStats(fn, opts = {}) {
  const ttlMs = opts.ttlMs ?? 6e4;
  const maxEntries = opts.maxEntries ?? 64;
  const now = opts.now ?? Date.now;
  const inFlight = /* @__PURE__ */ new Map();
  const done = /* @__PURE__ */ new Map();
  const stats = { hits: 0, coalesced: 0, misses: 0, size: () => done.size };
  const embed = (text) => {
    const key = createHash("sha256").update(text).digest("base64");
    const hit = done.get(key);
    if (hit) {
      if (now() - hit.at < ttlMs) {
        stats.hits += 1;
        done.delete(key);
        done.set(key, hit);
        return Promise.resolve(hit.vector);
      }
      done.delete(key);
    }
    const pending = inFlight.get(key);
    if (pending) {
      stats.coalesced += 1;
      return pending;
    }
    stats.misses += 1;
    const p = (async () => {
      const vector = await fn(text);
      if (Array.isArray(vector) && vector.length > 0) {
        done.set(key, { vector, at: now() });
        while (done.size > maxEntries) {
          const oldest = done.keys().next().value;
          if (oldest === void 0) break;
          done.delete(oldest);
        }
      }
      return vector;
    })();
    const tracked = p.finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, tracked);
    return tracked;
  };
  return { embed, stats };
}

// ../../libs/generic/memory/src/extraction-llm.ts
var ExtractionAuthError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtractionAuthError";
  }
};
var FallbackExtractionLlm = class {
  constructor(primary, buildFallback, opts) {
    this.primary = primary;
    this.buildFallback = buildFallback;
    this.opts = opts;
  }
  demoted = false;
  fallbackPromise;
  /** Test/diagnostic hook: has the primary been sticky-demoted? */
  get isDemoted() {
    return this.demoted;
  }
  label() {
    return this.opts.primaryLabel ?? "session extraction LLM";
  }
  async fallback() {
    this.fallbackPromise ??= this.buildFallback().catch((e) => {
      this.opts.warn(
        `extraction fallback rung failed to build: ${e.message}`
      );
      return null;
    });
    return this.fallbackPromise;
  }
  async route(viaPrimary, viaFallback) {
    if (!this.demoted) {
      try {
        return await viaPrimary();
      } catch (e) {
        const err = e;
        if (err instanceof ExtractionAuthError) {
          this.demoted = true;
          this.opts.warn(
            `${this.label()} auth-rejected after refresh+retry \u2014 demoting to API-key extraction for this process lifetime (re-probed next boot): ${err.message}`
          );
        } else {
          this.opts.warn(
            `${this.label()} failed (${err.message.slice(0, 140)}) \u2014 serving this extraction from the API-key rung`
          );
        }
        const fb2 = await this.fallback();
        if (!fb2) {
          this.opts.warn(
            `no API-key extraction rung available \u2014 this extraction is LOST (add a key at /settings/api-keys or restore the Claude session)`
          );
          throw err;
        }
        return viaFallback(fb2);
      }
    }
    const fb = await this.fallback();
    if (!fb) {
      throw new ExtractionAuthError(
        `${this.label()} demoted and no API-key extraction rung available`
      );
    }
    return viaFallback(fb);
  }
  generateResponse(messages, responseFormat, tools) {
    return this.route(
      () => this.primary.generateResponse(messages, responseFormat, tools),
      (fb) => fb.generateResponse(messages, responseFormat, tools)
    );
  }
  generateChat(messages) {
    return this.route(
      () => this.primary.generateChat(messages),
      (fb) => fb.generateChat(messages)
    );
  }
};

// ../../libs/generic/memory/src/dynamic-import.ts
var newFunctionImport = new Function("specifier", "return import(specifier)");
var NO_IMPORT_CALLBACK = /dynamic import callback was not specified/i;
async function dynamicImport(specifier) {
  try {
    return await newFunctionImport(specifier);
  } catch (err) {
    if (!NO_IMPORT_CALLBACK.test(err?.message ?? "")) throw err;
    return await import(
      /* @vite-ignore */
      specifier
    );
  }
}

// ../../libs/generic/memory/src/mem0-client.ts
var LLM_MODEL = "claude-haiku-4-5";
var MEM0_COLLECTION_PREFIX = "operator_memory";
var _factoryPatched = false;
var _embedderFactoryPatched = false;
var _llmFactoryPatched = false;
var _currentEmbedFn = null;
function patchVectorStoreFactory(mem0Module) {
  if (_factoryPatched) return;
  const Factory = mem0Module.VectorStoreFactory;
  if (!Factory || typeof Factory.create !== "function") {
    warnOnce("mem0 VectorStoreFactory not patchable (interface changed?); canonical store unavailable");
    return;
  }
  const orig = Factory.create.bind(Factory);
  Factory.create = (provider, config) => {
    if (provider === "canonical") {
      const store = new CanonicalVectorStore(
        config
      );
      _liveCanonicalStores.add(store);
      return store;
    }
    return orig(provider, config);
  };
  _factoryPatched = true;
}
var _liveCanonicalStores = /* @__PURE__ */ new Set();
async function disposeLiveCanonicalStores() {
  const stores = [..._liveCanonicalStores];
  _liveCanonicalStores.clear();
  await Promise.allSettled(stores.map((s) => s.dispose()));
}
async function updateMemoryPayload(id, patch) {
  await getMemoryClient();
  const store = [..._liveCanonicalStores][0];
  if (!store) throw new Error("mem0_unavailable");
  return store.updatePayload(id, patch);
}
async function lexicalSearchCanonical(query, topK, filters) {
  await getMemoryClient();
  const store = [..._liveCanonicalStores][0];
  if (!store) throw new Error("mem0_unavailable");
  return store.lexicalSearch(query, topK, filters);
}
async function vectorSearchCanonical(vector, topK, filters) {
  await getMemoryClient();
  const store = [..._liveCanonicalStores][0];
  if (!store) throw new Error("mem0_unavailable");
  return store.search(vector, topK, filters);
}
async function embedForCurrentClient(text) {
  const client = await getMemoryClient().catch(() => null);
  if (!client || !_currentEmbedFn) return null;
  try {
    return await _currentEmbedFn(text);
  } catch {
    return null;
  }
}
async function invalidateEntryCanonical(id, opts = {}) {
  await getMemoryClient();
  const store = [..._liveCanonicalStores][0];
  if (!store) throw new Error("mem0_unavailable");
  return store.invalidate(id, opts);
}
function patchEmbedderFactory(mem0Module) {
  if (_embedderFactoryPatched) return;
  const Factory = mem0Module.EmbedderFactory;
  if (!Factory || typeof Factory.create !== "function") {
    warnOnce("mem0 EmbedderFactory not patchable (interface changed?); custom embedder unavailable");
    return;
  }
  const orig = Factory.create.bind(Factory);
  Factory.create = (provider, config) => {
    if (provider === "custom") {
      return {
        embed: (text) => _currentEmbedFn(text),
        embedBatch: (texts) => Promise.all(texts.map((t) => _currentEmbedFn(t)))
      };
    }
    return orig(provider, config);
  };
  _embedderFactoryPatched = true;
}
var _currentExtractionLlm = null;
function patchLlmFactory(mem0Module) {
  if (_llmFactoryPatched) return;
  const Factory = mem0Module.LLMFactory;
  if (!Factory || typeof Factory.create !== "function") {
    warnOnce("mem0 LLMFactory not patchable (interface changed?); session extraction unavailable");
    return;
  }
  const orig = Factory.create.bind(Factory);
  Factory.create = (provider, config) => {
    if (provider === "custom") {
      const llm = {
        generateResponse: (messages, responseFormat, tools) => _currentExtractionLlm.generateResponse(messages, responseFormat, tools),
        generateChat: (messages) => _currentExtractionLlm.generateChat(messages)
      };
      return llm;
    }
    return orig(provider, config);
  };
  _llmFactoryPatched = true;
}
var MEM0_PACKAGE = "mem0ai/oss";
var _client = null;
var _clientMode = null;
var _clientBuiltAt = 0;
var _clientTtlMs = 60 * 60 * 1e3;
var _clientPermanentFailure = false;
var _seenWarnReasons = /* @__PURE__ */ new Set();
function warnOnce(reason) {
  if (_seenWarnReasons.has(reason)) return;
  _seenWarnReasons.add(reason);
  console.warn(`[mem0] ${reason}.`);
}
var _anthropicKeyProbeCache = /* @__PURE__ */ new Map();
async function anthropicKeyUsable(key, fetchImpl = fetch) {
  const cached = _anthropicKeyProbeCache.get(key);
  if (cached !== void 0) return cached;
  let usable = true;
  try {
    const r = await fetchImpl("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }
    });
    usable = !(r.status === 401 || r.status === 403);
  } catch {
    usable = true;
  }
  _anthropicKeyProbeCache.set(key, usable);
  return usable;
}
async function resolveExtractionLlmConfig(keys, probe = anthropicKeyUsable, sessionLlm) {
  if (sessionLlm) {
    return { provider: "custom", config: {} };
  }
  const { anthropicKey, openaiKey } = keys;
  const anthropicOk = anthropicKey ? await probe(anthropicKey) : false;
  if (anthropicKey && anthropicOk) {
    return { provider: "anthropic", config: { apiKey: anthropicKey, model: LLM_MODEL } };
  }
  if (openaiKey) {
    if (anthropicKey) {
      warnOnce(
        "anthropic key rejected (401/403) \u2014 falling back to OpenAI gpt-4o-mini for fact extraction; rotate the key at /settings/api-keys"
      );
    }
    return { provider: "openai", config: { apiKey: openaiKey, model: "gpt-4o-mini" } };
  }
  if (anthropicKey) {
    warnOnce(
      "anthropic key rejected (401/403) and no OpenAI key \u2014 mem0 fact extraction WILL fail until the key is rotated at /settings/api-keys (search + verbatim writes still work)"
    );
    return { provider: "anthropic", config: { apiKey: anthropicKey, model: LLM_MODEL } };
  }
  return null;
}
var _clientBuildPromise = null;
async function tryLoad() {
  if (_client && Date.now() - _clientBuiltAt < _clientTtlMs) return _client;
  if (_clientPermanentFailure) return null;
  if (_clientBuildPromise) return _clientBuildPromise;
  _clientBuildPromise = buildClient().finally(() => {
    _clientBuildPromise = null;
  });
  return _clientBuildPromise;
}
async function buildClient() {
  if (_client) {
    _client = null;
    void disposeLiveCanonicalStores();
  }
  if (_clientPermanentFailure) return null;
  const resolved = await memoryHost().resolveEmbedder();
  if (resolved.mode === "disabled") {
    if (resolved.reason && resolved.reason !== "user_disabled") {
      warnOnce(`embedder unavailable: ${resolved.reason} (set memoryEmbedderMode in /settings/user)`);
    }
    return null;
  }
  const coalescedEmbed = coalesceEmbedFn(resolved.embed);
  let pgFields2;
  try {
    const { pgFields: getFields } = await Promise.resolve().then(() => (init_mem0_connection(), mem0_connection_exports));
    pgFields2 = await getFields();
  } catch (e) {
    warnOnce(`couldn't resolve PG connection: ${e.message}`);
    return null;
  }
  const creds = await memoryHost().getCredentials();
  const anthropicKey = creds.anthropic_api_key ?? process.env.ANTHROPIC_API_KEY ?? "";
  const openaiKey = creds.openai_api_key ?? process.env.OPENAI_API_KEY ?? "";
  let sessionLlm = null;
  try {
    sessionLlm = await memoryHost().getExtractionLlm?.() ?? null;
  } catch (e) {
    warnOnce(`host getExtractionLlm threw (${e.message}); using key rungs`);
  }
  const llmConfig = await resolveExtractionLlmConfig({ anthropicKey, openaiKey }, void 0, sessionLlm);
  if (!llmConfig) {
    warnOnce("no Claude session and no Anthropic or OpenAI API key in operator-credentials or env (add at /settings/api-keys)");
    return null;
  }
  const collectionName = `${MEM0_COLLECTION_PREFIX}_${resolved.mode}`;
  const vecTable = resolved.mode === "openai" ? "memory_vec_openai" : resolved.mode === "gemma" ? "memory_vec_gemma" : resolved.mode === "harrier" ? "memory_vec_harrier" : "memory_vec_local";
  let vectorStoreConfig;
  try {
    const pgMod = await Promise.resolve().then(() => (init_esm(), esm_exports));
    const Client2 = pgMod.Client ?? pgMod.default?.Client;
    if (!Client2) throw new Error("pg.Client not resolvable");
    const probe = new Client2({ host: pgFields2.host, port: pgFields2.port, user: pgFields2.user, password: pgFields2.password, database: pgFields2.dbname });
    await probe.connect();
    const r = await probe.query("SELECT 1 FROM pg_available_extensions WHERE name='vector'");
    await probe.end();
    if (r.rowCount && r.rowCount > 0) {
      vectorStoreConfig = {
        provider: "canonical",
        config: {
          host: pgFields2.host,
          port: pgFields2.port,
          user: pgFields2.user,
          password: pgFields2.password,
          dbname: pgFields2.dbname,
          schema: memorySchema(),
          collectionName,
          vecTable,
          embeddingModelDims: resolved.dims,
          // mem0 `_autoInitialize` reads `vectorStore.config.dimension` to skip its
          // live-embed detection probe (see embedderConfig note) \u2014 EI-4027.
          dimension: resolved.dims
        }
      };
    } else {
      warnOnce("pgvector extension not available in embedded PG \u2014 falling back to in-process memory store (volatile)");
      vectorStoreConfig = {
        provider: "memory",
        config: { collectionName, embeddingModelDims: resolved.dims }
      };
    }
  } catch (e) {
    warnOnce(`pgvector probe failed: ${e.message}; falling back to in-process memory store`);
    vectorStoreConfig = {
      provider: "memory",
      config: { collectionName, embeddingModelDims: resolved.dims }
    };
  }
  const embedderConfig = {
    provider: "custom",
    config: { embed: coalescedEmbed, embeddingDims: resolved.dims }
  };
  let historyDbPath = ":memory:";
  const localStoreDir = memoryHost().localStoreDir;
  if (localStoreDir !== null) {
    try {
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      const dir = localStoreDir ?? os.tmpdir();
      await fs.mkdir(dir, { recursive: true });
      historyDbPath = path.join(dir, "mem0-history.db");
    } catch {
    }
  }
  let customInstructions;
  try {
    customInstructions = await memoryHost().getLearningInstructions?.() ?? void 0;
  } catch {
  }
  try {
    const nlpFix = process.env.PAPERCUSP_MEMORY_ENTITY_NLP !== "off";
    const gt = globalThis;
    const hadGlobalRequire = "require" in globalThis;
    let installedRequire = false;
    if (nlpFix && !hadGlobalRequire) {
      try {
        const { createRequire: createRequire2 } = await import("node:module");
        gt.require = createRequire2(import.meta.url);
        installedRequire = true;
      } catch {
      }
    }
    let mem0;
    try {
      mem0 = await dynamicImport(MEM0_PACKAGE);
    } finally {
      if (installedRequire) {
        try {
          delete gt.require;
        } catch {
          gt.require = void 0;
        }
      }
    }
    patchVectorStoreFactory(mem0);
    _currentEmbedFn = coalescedEmbed;
    patchEmbedderFactory(mem0);
    if (sessionLlm) {
      patchLlmFactory(mem0);
      _currentExtractionLlm = new FallbackExtractionLlm(
        sessionLlm,
        async () => {
          const cfg = await resolveExtractionLlmConfig({ anthropicKey, openaiKey });
          if (!cfg || !mem0.LLMFactory) return null;
          return mem0.LLMFactory.create(
            cfg.provider,
            cfg.config
          );
        },
        { warn: warnOnce, primaryLabel: "claude-session extraction" }
      );
    }
    const { Memory } = mem0;
    _client = new Memory({
      embedder: embedderConfig,
      vectorStore: vectorStoreConfig,
      llm: llmConfig,
      historyDbPath,
      ...customInstructions ? { customInstructions } : {}
    });
    _clientMode = resolved.mode;
    _clientBuiltAt = Date.now();
    const clientToWarm = _client;
    void (async () => {
      try {
        await clientToWarm.search("warmup", { filters: { user_id: "__mem0_warmup__" }, topK: 1, limit: 1 });
      } catch {
      }
    })();
    return _client;
  } catch (e) {
    const msg = e.message ?? String(e);
    if (/cannot find module|MODULE_NOT_FOUND|Cannot resolve/i.test(msg)) {
      _clientPermanentFailure = true;
      warnOnce(`${msg}. Run 'npm install --legacy-peer-deps' in apps/operator to enable.`);
    } else {
      warnOnce(msg);
    }
    return null;
  }
}
async function getMemoryClient() {
  return tryLoad();
}
function invalidateMemoryClient() {
  _client = null;
  _clientBuiltAt = 0;
  void disposeLiveCanonicalStores();
}

// ../../libs/generic/memory/src/backend.ts
var MemoryUnavailableError = class extends Error {
  constructor(reason) {
    super(`memory backend unavailable: ${reason}`);
    this.reason = reason;
    this.name = "MemoryUnavailableError";
  }
};
function scopesOf(scope) {
  const arr = typeof scope === "string" ? [scope] : [...scope];
  return [...new Set(arr.filter((s) => typeof s === "string" && s.length > 0))];
}

// ../../libs/generic/memory/src/score-floor.ts
function applyScoreFloor(entries, opts) {
  const { minScore, minScoreRatio } = opts;
  if (minScore === void 0 && minScoreRatio === void 0) return [...entries];
  const scores = entries.map((e) => e.score).filter((s) => typeof s === "number");
  if (scores.length === 0) return [...entries];
  const top = Math.max(...scores);
  const absFloor = minScore ?? -Infinity;
  const relFloor = minScoreRatio !== void 0 ? minScoreRatio * top : -Infinity;
  const floor = Math.max(absFloor, relFloor);
  return entries.filter((e) => typeof e.score !== "number" || e.score >= floor);
}

// ../../libs/generic/memory/src/diversity-rerank.ts
function diversityRerank(entries, opts) {
  const lambda = clamp01(opts.lambda ?? 1);
  if (entries.length <= 1 || lambda >= 1) return [...entries];
  const { similarity } = opts;
  const rawScores = entries.map((e) => typeof e.score === "number" ? e.score : 0);
  const maxScore = Math.max(0, ...rawScores) || 1;
  const remaining = entries.map((e, i) => ({ e, norm: rawScores[i] / maxScore }));
  const selected = [];
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      let maxSim = 0;
      for (const s of selected) {
        const sim = similarity(cand.e, s);
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * cand.norm - (1 - lambda) * maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    selected.push(remaining[bestIdx].e);
    remaining.splice(bestIdx, 1);
  }
  return selected;
}
function clamp01(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}
function trigrams(s) {
  const norm = s.toLowerCase().replace(/\s+/g, " ").trim();
  if (norm.length === 0) return /* @__PURE__ */ new Set();
  if (norm.length < 3) return /* @__PURE__ */ new Set([norm]);
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i <= norm.length - 3; i++) out.add(norm.slice(i, i + 3));
  return out;
}
function createTextSimilarity() {
  const cache = /* @__PURE__ */ new WeakMap();
  const gramsOf = (entry) => {
    let g = cache.get(entry);
    if (g === void 0) {
      g = trigrams(entry.text);
      cache.set(entry, g);
    }
    return g;
  };
  return (a, b) => {
    if (a === b) return 1;
    const ta = gramsOf(a);
    const tb = gramsOf(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    let inter = 0;
    for (const t of small) if (large.has(t)) inter++;
    const union = ta.size + tb.size - inter;
    return union === 0 ? 0 : inter / union;
  };
}
function diversityDisabledByEnv() {
  return process.env.PAPERCUSP_MEMORY_MMR === "0";
}

// ../../libs/generic/memory/src/vec-write.ts
init_config();
var VEC_TABLE = {
  openai: "memory_vec_openai",
  local: "memory_vec_local",
  gemma: "memory_vec_gemma",
  harrier: "memory_vec_harrier"
};
var MODE_DIMS = {
  openai: 768,
  local: 384,
  gemma: 768,
  harrier: 1024
};
function vecUpsertSql(schema, mode) {
  return `INSERT INTO ${schema}.${VEC_TABLE[mode]} (memory_id, vector, embedded_at)
          VALUES ($1, $2::vector, now())
          ON CONFLICT (memory_id) DO UPDATE SET vector = EXCLUDED.vector, embedded_at = now()`;
}
function toVectorLiteral2(vec) {
  return `[${vec.join(",")}]`;
}
async function embedAndUpsertVector(memoryId, text) {
  try {
    const resolved = await memoryHost().resolveEmbedder();
    if (resolved.mode === "disabled") return false;
    const mode = resolved.mode;
    if (!VEC_TABLE[mode]) return false;
    const vec = await resolved.embed(text);
    if (!Array.isArray(vec) || vec.length !== MODE_DIMS[mode]) return false;
    const schema = memorySchema();
    const pgMod = await Promise.resolve().then(() => (init_esm(), esm_exports));
    const Client2 = pgMod.Client ?? pgMod.default?.Client;
    if (!Client2) return false;
    const { pgClientFields: pgClientFields2 } = await Promise.resolve().then(() => (init_mem0_connection(), mem0_connection_exports));
    const client = new Client2(await pgClientFields2());
    await client.connect();
    try {
      const r = await client.query(vecUpsertSql(schema, mode), [memoryId, toVectorLiteral2(vec)]);
      return (r.rowCount ?? 0) > 0;
    } finally {
      try {
        await client.end();
      } catch {
      }
    }
  } catch {
    return false;
  }
}

// ../../libs/generic/memory/src/mem0-backend.ts
function temporalFilters(opts) {
  return {
    ...opts.asOf !== void 0 ? { as_of: opts.asOf } : {},
    ...opts.includeSuperseded ? { include_superseded: "true" } : {}
  };
}
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var DEFAULT_SEARCH_LIMIT = 8;
var LIST_TOP_K = 5e3;
function decayEnabled() {
  return process.env.PAPERCUSP_MEMORY_DECAY !== "0";
}
function decayHalfLifeDays() {
  const v = Number(process.env.PAPERCUSP_MEMORY_DECAY_HALF_LIFE_DAYS);
  return Number.isFinite(v) && v > 0 ? v : 30;
}
function decayFloor() {
  const v = Number(process.env.PAPERCUSP_MEMORY_DECAY_FLOOR);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.9;
}
function recencyFactor(tsMs, nowMs) {
  if (tsMs === null) return 1;
  const ageDays = Math.max(0, (nowMs - tsMs) / 864e5);
  const floor = decayFloor();
  return floor + (1 - floor) * Math.pow(0.5, ageDays / decayHalfLifeDays());
}
function rowTimestampMs(row) {
  for (const key of ["updatedAt", "createdAt"]) {
    const raw = row[key];
    if (typeof raw === "string" || typeof raw === "number") {
      const t = new Date(raw).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}
function canonicalPayloadTimestampMs(payload) {
  for (const key of ["updated_at", "updatedAt", "created_at", "createdAt"]) {
    const raw = payload?.[key];
    if (typeof raw === "string" || typeof raw === "number") {
      const t = new Date(raw).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}
function rowEvent(row) {
  const direct = row?.event;
  if (typeof direct === "string") return direct.toUpperCase();
  const nested = row?.metadata?.event;
  return typeof nested === "string" ? nested.toUpperCase() : "";
}
function extractAddedIds(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const out = [];
  for (const row of rows) {
    if (rowEvent(row) !== "ADD") continue;
    const id = typeof row.id === "string" ? row.id : null;
    if (id && UUID_RE.test(id)) out.push(id);
  }
  return out;
}
function extractStoredEventCount(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  let n = 0;
  for (const row of rows) {
    const event = rowEvent(row);
    if (event === "ADD" || event === "UPDATE") n += 1;
  }
  return n;
}
function toEntry(row, scope) {
  const metadata = row.metadata ?? void 0;
  const kind = typeof metadata?.kind === "string" ? metadata.kind : void 0;
  return {
    id: row.id,
    text: row.memory ?? "",
    ...kind !== void 0 ? { kind } : {},
    scope,
    ...typeof row.score === "number" ? { score: row.score } : {},
    ...metadata !== void 0 ? { metadata } : {}
  };
}
function canonicalRowToEntry(row, scope) {
  const { data, user_id: _userId, ...rest } = row.payload ?? {};
  const kind = typeof rest.kind === "string" ? rest.kind : void 0;
  return {
    id: row.id,
    text: typeof data === "string" ? data : String(data ?? ""),
    ...kind !== void 0 ? { kind } : {},
    scope,
    ...typeof row.score === "number" ? { score: row.score } : {},
    ...Object.keys(rest).length > 0 ? { metadata: rest } : {}
  };
}
function mergeById(entries) {
  const byId = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const prior = byId.get(e.id);
    if (!prior || (e.score ?? 0) > (prior.score ?? 0)) byId.set(e.id, e);
  }
  return [...byId.values()];
}
var Mem0Backend = class {
  name = "mem0";
  /** pgvector similarity \u2014 an absolute, cross-call-comparable measure. */
  scoreScale = "cosine";
  /** The embed-free fallback scores token-overlap fractions, NOT cosine
   *  (see `searchLexical` below) \u2014 a different scale from the same backend. */
  lexicalScoreScale = "lexical";
  getClient;
  updatePayload;
  lexicalSearch;
  invalidateEntryStore;
  reembedVector;
  /** PUBLIC (EI-12992): satisfies MemoryBackend.embedQuery? \u2014 a caller issuing
   *  several search() calls against the same query text embeds once here and
   *  passes the result as SearchOptions.vector on each call. */
  embedQuery;
  vectorSearch;
  constructor(deps = {}) {
    this.getClient = deps.getClient ?? getMemoryClient;
    this.updatePayload = deps.updatePayload ?? updateMemoryPayload;
    this.lexicalSearch = deps.lexicalSearch ?? lexicalSearchCanonical;
    this.invalidateEntryStore = deps.invalidateEntry ?? invalidateEntryCanonical;
    this.reembedVector = deps.reembedVector ?? ((id, _scope, embedText) => embedAndUpsertVector(id, embedText));
    this.embedQuery = deps.embedQuery ?? (deps.getClient ? async () => null : embedForCurrentClient);
    this.vectorSearch = deps.vectorSearch ?? vectorSearchCanonical;
  }
  async available() {
    const client = await this.getClient().catch(() => null);
    return client ? { ok: true } : { ok: false, reason: "mem0_unavailable" };
  }
  /** Resolve the client or throw the contract's unavailable error. */
  async client() {
    const client = await this.getClient().catch(() => null);
    if (!client) throw new MemoryUnavailableError("mem0_unavailable");
    return client;
  }
  async remember(text, opts) {
    const client = await this.client();
    const metadata = { ...opts.metadata ?? {} };
    if (opts.kind !== void 0) metadata.kind = opts.kind;
    if (opts.shareable !== void 0) metadata.shareable = opts.shareable;
    const result = await client.add(text, {
      userId: opts.scope,
      metadata,
      ...opts.verbatim ? { infer: false } : {}
    });
    const ids = extractAddedIds(result);
    if (opts.verbatim && ids.length > 0) {
      const linker = client._linkEntitiesForMemory;
      if (typeof linker === "function") {
        for (const id of ids) {
          await linker.call(client, id, text, { user_id: opts.scope }).catch(() => {
          });
        }
      }
    }
    if (opts.embedText && opts.embedText !== text && ids.length > 0) {
      for (const id of ids) {
        await this.reembedVector(id, opts.scope, opts.embedText).catch(() => {
        });
      }
    }
    return { ids, storedEvents: extractStoredEventCount(result) };
  }
  async search(query, opts) {
    const client = await this.client();
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    const scopes = scopesOf(opts.scope);
    const tsById = /* @__PURE__ */ new Map();
    let merged = null;
    if (opts.vector || scopes.length > 1) {
      const vector = opts.vector ?? await this.embedQuery(query);
      if (vector) {
        const pulls = scopes.map(async (scope) => {
          const rows = await this.vectorSearch(vector, limit, {
            user_id: scope,
            ...temporalFilters(opts)
          });
          return rows.map((row) => {
            tsById.set(row.id, canonicalPayloadTimestampMs(row.payload));
            return canonicalRowToEntry(row, scope);
          });
        });
        merged = mergeById((await Promise.all(pulls)).flat());
      }
    }
    if (merged === null) {
      const pulls = scopes.map(async (scope) => {
        const r = await client.search(query, {
          filters: { user_id: scope, ...temporalFilters(opts) },
          topK: limit,
          limit
        });
        return (r.results ?? []).map((row) => {
          tsById.set(row.id, rowTimestampMs(row));
          return toEntry(row, scope);
        });
      });
      merged = mergeById((await Promise.all(pulls)).flat());
    }
    const ranked = merged.sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0)
    );
    const floored = applyScoreFloor(ranked, { minScore: opts.minScore, minScoreRatio: opts.minScoreRatio });
    const now = Date.now();
    const decayed = !decayEnabled() ? floored : [...floored].sort(
      (a, b) => (b.score ?? 0) * recencyFactor(tsById.get(b.id) ?? null, now) - (a.score ?? 0) * recencyFactor(tsById.get(a.id) ?? null, now)
    );
    if (!opts.diversify || diversityDisabledByEnv()) return decayed;
    return diversityRerank(decayed, {
      lambda: opts.diversify.lambda,
      similarity: createTextSimilarity()
    });
  }
  /**
   * EMBED-FREE lexical fallback (WI-4214, the `MemoryBackend.searchLexical`
   * capability): same per-scope fan-out + merge semantics as search(), but
   * served by a plain token-ILIKE query over `memory_canonical` \u2014 no
   * embedder anywhere on the path, so it works while the semantic leg is
   * saturated or down. Scores are token-overlap fractions (0..1, ordering
   * only \u2014 NOT cosine), so the relevance floor and decay deliberately do
   * not apply.
   */
  async searchLexical(query, opts) {
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    const pulls = scopesOf(opts.scope).map(async (scope) => {
      const rows = await this.lexicalSearch(query, limit, { user_id: scope, ...temporalFilters(opts) });
      return rows.map((row) => canonicalRowToEntry(row, scope));
    });
    return mergeById((await Promise.all(pulls)).flat()).sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0)
    );
  }
  async list(opts) {
    const client = await this.client();
    const pulls = scopesOf(opts.scope).map(async (scope) => {
      const r = await client.getAll({
        filters: { user_id: scope, ...temporalFilters(opts) },
        topK: LIST_TOP_K
      });
      return (r.results ?? []).map((row) => toEntry(row, scope));
    });
    let merged = mergeById((await Promise.all(pulls)).flat());
    if (opts.kind !== void 0) merged = merged.filter((e) => e.kind === opts.kind);
    return merged;
  }
  async get(id) {
    const client = await this.client();
    const row = await client.get(id);
    if (!row) return null;
    const scope = typeof row.user_id === "string" ? row.user_id : "";
    return toEntry(row, scope);
  }
  async forget(id) {
    const client = await this.client();
    await client.delete(id);
  }
  async update(id, patch) {
    if (patch.metadata !== void 0) {
      const matched = await this.updatePayload(id, patch.metadata);
      if (!matched) throw new Error(`Memory with ID ${id} not found`);
    }
    if (patch.text !== void 0) {
      const client = await this.client();
      await client.update(id, patch.text);
    }
  }
  /** mem0's LLM fact-extraction over a conversation window. */
  async rememberConversation(messages, opts) {
    const client = await this.client();
    const metadata = { ...opts.metadata ?? {} };
    if (opts.kind !== void 0) metadata.kind = opts.kind;
    const result = await client.add([...messages], { userId: opts.scope, metadata });
    return { ids: extractAddedIds(result), storedEvents: extractStoredEventCount(result) };
  }
  invalidate() {
    invalidateMemoryClient();
  }
  /**
   * Temporal-lite validity close (the `MemoryBackend.invalidateEntry`
   * capability): soft-forget / supersession as a vec-safe column update on
   * the canonical store \u2014 never a delete, never a re-embed. Returns false
   * when no OPEN memory row matched (unknown id or already closed).
   */
  async invalidateEntry(id, opts = {}) {
    return this.invalidateEntryStore(id, opts);
  }
};

// ../../libs/generic/memory/src/noop-backend.ts
var NOOP_DISABLED_REASON = "memory_backend_disabled";
var NoopBackend = class {
  name = "noop";
  /** Never returns an entry (every method throws unavailable), so there are
   *  no scores to place on a scale. Declared rather than omitted to make the
   *  "nothing to say" explicit instead of looking like an oversight. */
  scoreScale = "unknown";
  async available() {
    return { ok: false, reason: NOOP_DISABLED_REASON };
  }
  async remember(_text, _opts) {
    throw new MemoryUnavailableError(NOOP_DISABLED_REASON);
  }
  async search(_query, _opts) {
    return [];
  }
  async list(_opts) {
    return [];
  }
  async get(_id) {
    return null;
  }
  async forget(_id) {
    throw new MemoryUnavailableError(NOOP_DISABLED_REASON);
  }
  async update(_id, _patch) {
    throw new MemoryUnavailableError(NOOP_DISABLED_REASON);
  }
};

// ../../libs/generic/memory/src/backend-registry.ts
init_src();
init_config();
var STATE_KEY2 = "@papercusp/memory:backend-registry";
function builtinFactories() {
  return /* @__PURE__ */ new Map([
    ["mem0", () => new Mem0Backend()],
    ["noop", () => new NoopBackend()]
  ]);
}
var state2 = pinModuleState(STATE_KEY2, () => ({
  registry: builtinFactories(),
  instances: /* @__PURE__ */ new Map()
}));

// ../../libs/generic/memory/src/index.ts
init_mem0_connection();

// ../../libs/generic/memory/src/reembed.ts
init_config();

// ../../libs/generic/memory/src/relink-entities.ts
init_config();

// ../../libs/generic/memory/src/local-embedder-worker.ts
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, dirname, isAbsolute, join } from "node:path";
var _worker = null;
var _workerReady = null;
var _nextId = 0;
var _pending = /* @__PURE__ */ new Map();
var _workerDisabled = false;
var _beforeExitHookInstalled = false;
var _beforeExitListener = null;
var _refd = false;
function syncWorkerRef() {
  const want = _pending.size > 0;
  if (!_worker || want === _refd) return;
  if (want) _worker.ref();
  else _worker.unref();
  _refd = want;
}
var WORKER_SCRIPT_NAME = "local-embedder-worker.script.mjs";
function runtimeFilename() {
  try {
    return typeof __filename === "string" ? __filename : void 0;
  } catch {
    return void 0;
  }
}
function runtimeMetaUrl() {
  try {
    return typeof import.meta.url === "string" ? import.meta.url : void 0;
  } catch {
    return void 0;
  }
}
function packageEntry() {
  try {
    const requireFn = typeof __require === "function" ? __require : (() => {
      const url = runtimeMetaUrl();
      const filename = runtimeFilename();
      if (url?.startsWith("file:")) return createRequire(url);
      if (filename && isAbsolute(filename)) return createRequire(filename);
      return void 0;
    })();
    return requireFn?.resolve("@papercusp/memory");
  } catch {
    return void 0;
  }
}
function ancestorDirectories(start, maxDepth = 8) {
  const roots = [];
  let current = resolve(start);
  for (let i = 0; i <= maxDepth; i += 1) {
    roots.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}
function resolveWorkerScriptPath(probe = {}) {
  const exists = probe.exists ?? existsSync;
  const filename = probe.filename === void 0 ? runtimeFilename() : probe.filename ?? void 0;
  const metaUrl = probe.metaUrl === void 0 ? runtimeMetaUrl() : probe.metaUrl ?? void 0;
  const cwd = probe.cwd === void 0 ? process.cwd() : probe.cwd ?? void 0;
  const entry = probe.packageEntry === void 0 ? packageEntry() : probe.packageEntry ?? void 0;
  const candidates = [];
  const add = (candidate) => {
    if (!candidate) return;
    const absolute = resolve(candidate);
    if (!candidates.includes(absolute)) candidates.push(absolute);
  };
  if (metaUrl?.startsWith("file:")) {
    try {
      add(join(dirname(fileURLToPath(metaUrl)), WORKER_SCRIPT_NAME));
    } catch {
    }
  }
  if (filename && isAbsolute(filename)) add(join(dirname(filename), WORKER_SCRIPT_NAME));
  if (entry) {
    add(join(dirname(entry), WORKER_SCRIPT_NAME));
    add(join(dirname(dirname(entry)), "src", WORKER_SCRIPT_NAME));
    add(join(dirname(dirname(entry)), "dist", WORKER_SCRIPT_NAME));
  }
  if (cwd) {
    for (const root of ancestorDirectories(cwd)) {
      add(join(root, WORKER_SCRIPT_NAME));
      add(join(root, "src", WORKER_SCRIPT_NAME));
      add(join(root, "dist", WORKER_SCRIPT_NAME));
      add(join(root, "libs", "generic", "memory", "src", WORKER_SCRIPT_NAME));
      add(join(root, "libs", "generic", "memory", "dist", WORKER_SCRIPT_NAME));
    }
  }
  const found = candidates.find((candidate) => {
    try {
      return exists(candidate);
    } catch {
      return false;
    }
  });
  if (found) return found;
  throw new Error(
    `Unable to locate ${WORKER_SCRIPT_NAME}; checked ${candidates.slice(0, 8).join(", ") || "(no candidates)"}.`
  );
}
function workerPath() {
  return resolveWorkerScriptPath();
}
function ensureWorker() {
  if (_workerDisabled) return Promise.reject(new Error("worker disabled"));
  if (_workerReady) return _workerReady;
  _workerReady = new Promise((resolveReady, rejectReady) => {
    try {
      _worker = new Worker(workerPath(), {
        // execArgv passthrough is fine \u2014 the script is plain JS,
        // no ts-node loader needed.
      });
    } catch (err) {
      _workerDisabled = true;
      rejectReady(err);
      return;
    }
    let initialized = false;
    _worker.on("message", (msg) => {
      if (msg.kind === "ready") {
        initialized = true;
        syncWorkerRef();
        installBeforeExitHook();
        resolveReady();
        return;
      }
      if (typeof msg.id !== "number") return;
      const p = _pending.get(msg.id);
      if (!p) return;
      _pending.delete(msg.id);
      syncWorkerRef();
      if (msg.kind === "embed_ok" && Array.isArray(msg.vector)) {
        p.resolve(msg.vector);
      } else {
        p.reject(new Error(msg.error ?? "worker error"));
      }
    });
    _worker.on("error", (err) => {
      for (const [, p] of _pending) p.reject(err);
      _pending.clear();
      _worker = null;
      _workerReady = null;
      _refd = false;
      if (!initialized) rejectReady(err);
    });
    _worker.on("exit", (code) => {
      if (code !== 0 && !initialized) {
        rejectReady(new Error(`worker exited with code ${code} before ready`));
      }
      if (_pending.size > 0) {
        const err = new Error(`embedder worker exited with code ${code} while ${_pending.size} request(s) were in flight`);
        for (const [, p] of _pending) p.reject(err);
        _pending.clear();
      }
      _worker = null;
      _workerReady = null;
      _refd = false;
    });
  });
  return _workerReady;
}
async function embedViaWorker(text, opts = {}) {
  await ensureWorker();
  if (!_worker) throw new Error("worker not initialized");
  const id = _nextId++;
  return new Promise((resolveEmbed, rejectEmbed) => {
    _pending.set(id, { resolve: resolveEmbed, reject: rejectEmbed });
    syncWorkerRef();
    _worker.postMessage({
      kind: "embed",
      id,
      text,
      model: opts.model,
      pooling: opts.pooling,
      normalize: opts.normalize,
      output: opts.output
    });
  });
}
async function _resetWorker() {
  if (_worker) {
    try {
      await _worker.terminate();
    } catch {
    }
  }
  _worker = null;
  _workerReady = null;
  _workerDisabled = false;
  if (_pending.size > 0) {
    const err = new Error(`embedder worker was shut down while ${_pending.size} request(s) were in flight`);
    for (const [, p] of _pending) p.reject(err);
  }
  _pending.clear();
  _refd = false;
  _nextId = 0;
}
var shutdownLocalEmbedder = _resetWorker;
function installBeforeExitHook() {
  if (_beforeExitHookInstalled) return;
  _beforeExitHookInstalled = true;
  _beforeExitListener = async () => {
    if (_pending.size > 0) return;
    await _resetWorker();
  };
  process.on("beforeExit", _beforeExitListener);
}
function getWorkerState() {
  return {
    alive: _worker !== null,
    disabled: _workerDisabled,
    pendingCount: _pending.size,
    keepAlive: _refd
  };
}
var _lastFallbackWarnAt = 0;
var FALLBACK_WARN_COOLDOWN_MS = 3e4;
function warnEmbedFallback(model, err) {
  const now = Date.now();
  if (now - _lastFallbackWarnAt < FALLBACK_WARN_COOLDOWN_MS) return;
  _lastFallbackWarnAt = now;
  if (process.env.NODE_ENV !== "test") {
    console.warn(
      `[embed] ${model} worker path failed \u2014 falling back to inline (main-thread, blocks the event loop) for this call: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
var LOCAL_EMBEDDER_MODEL = "Xenova/bge-small-en-v1.5";
var TRANSFORMERS_PACKAGE = "@huggingface/transformers";
var MAX_INTRA_OP_THREADS = 4;
var BACKGROUND_HOST_SHARE_DIVISOR = 4;
function resolveIntraOpNumThreads(hostCores) {
  if (!Number.isFinite(hostCores) || hostCores < 1) return 1;
  return Math.max(
    1,
    Math.min(MAX_INTRA_OP_THREADS, Math.floor(hostCores / BACKGROUND_HOST_SHARE_DIVISOR))
  );
}
function hostParallelism() {
  try {
    return availableParallelism();
  } catch {
    return 1;
  }
}
var ORT_SESSION_OPTIONS = {
  intraOpNumThreads: resolveIntraOpNumThreads(hostParallelism()),
  interOpNumThreads: 1
};
async function buildLocalEmbedder() {
  let pipelinePromise = null;
  return async (text) => {
    if (!getWorkerState().disabled) {
      try {
        return await embedViaWorker(text);
      } catch (err) {
        warnEmbedFallback("local", err);
      }
    }
    if (!pipelinePromise) {
      const transformers = await dynamicImport(TRANSFORMERS_PACKAGE);
      pipelinePromise = transformers.pipeline("feature-extraction", LOCAL_EMBEDDER_MODEL, {
        session_options: ORT_SESSION_OPTIONS
      });
    }
    const pipe = await pipelinePromise;
    const result = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(result.data);
  };
}

// ../../libs/generic/memory/src/embedder-dims.ts
var EMBEDDER_DIM_SPECS = {
  /**
   * BGE-small is natively 384 \u2014 no truncation happens at all, which is why
   * this mode never had the bug.
   */
  local: {
    model: "Xenova/bge-small-en-v1.5",
    nativeDims: 384,
    mrl: "none",
    trainedDims: [384],
    targetDims: 384
  },
  /**
   * OpenAI text-embedding-3-small. Reduction is first-class here: the
   * `dimensions` API parameter applies the trained MRL and renormalizes
   * server-side, so any width is SUPPORTED, not a hand-rolled prefix.
   * This is the contrast case that keeps the guard honest \u2014 it must not
   * flag every non-native width, only untrained ones.
   *
   * 768 (was 384) tracks the prose column width so this mode stays
   * PROSE-ELIGIBLE alongside gemma \u2014 see `PROSE_ELIGIBLE_MODES` in
   * operator-core's `search/prose-vector-dims.ts`. It costs nothing to move:
   * OpenAI bills per TOKEN, not per dimension, and `dimensions` is applied
   * server-side. Keeping a second eligible mode matters \u2014 it is the working
   * prose fallback when gemma is unavailable, and it keeps the storage
   * contract from silently becoming gemma-specific.
   */
  openai: {
    model: "text-embedding-3-small",
    nativeDims: 1536,
    mrl: "continuous",
    trainedDims: [1536],
    targetDims: 768
  },
  /**
   * EmbeddingGemma-300m at its NATIVE 768 \u2014 the case this guard was built for,
   * resolved by REMOVING the truncation rather than relocating it to a
   * different trained point (P-005 / D-005).
   *
   * The former `targetDims: 384` was an intermediate, untrained MRL cut taken
   * to fit the pre-existing `vector(384)` columns. Measured (D-003), it cost
   * ~19-21% of prose retrieval MRR: @384 scores .2889 against @512 .3435 and
   * @768 .3492, and the paired bootstrap vs @384 excludes zero for both
   * (@512 +.0546 CI [.0165,.0935]; @768 +.0603 CI [.0210,.1022]).
   *
   * WHY NATIVE 768 AND NOT THE TRAINED 512 (D-005). @768 is better on both the
   * point estimate and the CI lower bound, and \u2014 the decisive part \u2014 costs the
   * SAME compute: the model always runs a native-768 forward pass, so an MRL
   * "truncation" is only a slice afterwards. 512 would buy ~400MB of disk at
   * the price of keeping the truncation machinery, and therefore keeping this
   * bug class one config typo away. At the native width `targetDims ===
   * nativeDims`, so `isTrainedDim` is trivially true and no acknowledgement can
   * ever be needed here again.
   *
   * \u26a0 Do NOT "optimize" this back down to a narrower prefix without re-reading
   * D-005: the re-embed corpus is ~395k vectors, so a width change is a
   * multi-hour, all-at-once migration (pgvector cannot cast between widths).
   * That cost is why the width chosen here is the model's terminal one.
   */
  gemma: {
    model: "onnx-community/embeddinggemma-300m-ONNX",
    nativeDims: 768,
    mrl: "discrete",
    trainedDims: [768, 512, 256, 128],
    targetDims: 768
  },
  /**
   * harrier-oss-v1-0.6b at its NATIVE 1024 (its own vector(1024) table), so
   * the configured target needs no acknowledgement. Harrier publishes no MRL
   * at all, which is why the exploratory `dims: 384` variant is an untrained
   * cut \u2014 see `isTrainedDim`, which reports it as such, and the P-001 gate it
   * must win before any prose-surface use.
   */
  harrier: {
    model: "microsoft/harrier-oss-v1-0.6b",
    nativeDims: 1024,
    mrl: "none",
    trainedDims: [1024],
    targetDims: 1024
  }
};
var CANDIDATE_DIM_SPECS = {
  /**
   * Granite-Embedding-97M-Multilingual-R2 \u2014 natively 384. The cheapest
   * possible resolution of the untrained-cut bug: at the width the prose
   * columns already store, there is no truncation happening at all, so the
   * question "is this cut trained?" does not arise.
   */
  granite97: {
    model: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
    nativeDims: 384,
    mrl: "none",
    trainedDims: [384],
    targetDims: 384
  },
  /**
   * Granite-Embedding-311M-Multilingual-R2 \u2014 768 native, with card-published
   * Matryoshka nesting at 768/512/384/256/128. 384 is among them, so
   * `targetDims: 384` needs no `untrainedCut` acknowledgement (and if someone
   * later adds one anyway, the validator's stale-ack rule rejects it).
   *
   * That is a statement about DECLARABILITY, not quality \u2014 see the warning on
   * this table. Whether 311m@384 actually beats gemma@512 is P-003's
   * measurement to make.
   */
  granite311: {
    model: "onnx-community/granite-embedding-311m-multilingual-r2-ONNX",
    nativeDims: 768,
    mrl: "discrete",
    trainedDims: [768, 512, 384, 256, 128],
    targetDims: 384
  },
  /**
   * Qwen3-Embedding-0.6B \u2014 1024 native, card-documented MRL across
   * user-defined widths from 32 to 1024, so reduction is first-class the way
   * OpenAI's `dimensions` parameter is (hence `continuous`).
   *
   * \u26a0 `continuous` here means "trained at any width in the published range",
   * and that range has a FLOOR of 32 which this model shares with no other
   * entry. `isTrainedDim` cannot express a floor, so it would call dims 1..31
   * trained. Our target of 384 sits far inside the range; a future caller
   * asking for a sub-32 width would need that floor checked by hand.
   */
  qwen3: {
    model: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    nativeDims: 1024,
    mrl: "continuous",
    trainedDims: [1024],
    targetDims: 384
  }
};

// ../../libs/generic/memory/src/gemma-embedder.ts
var GEMMA_MODEL = "onnx-community/embeddinggemma-300m-ONNX";
var TRANSFORMERS_PACKAGE2 = "@huggingface/transformers";
var GEMMA_TARGET_DIMS = EMBEDDER_DIM_SPECS.gemma.targetDims;
function gemmaPrompt(kind, text) {
  return kind === "query" ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
}
function mrlTruncate(vec, dims = GEMMA_TARGET_DIMS) {
  const sliced = vec.length > dims ? vec.slice(0, dims) : vec;
  let sumSq = 0;
  for (const v of sliced) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return sliced;
  return sliced.map((v) => v / norm);
}
function buildGemmaEmbedder(opts) {
  const { kind, dims = GEMMA_TARGET_DIMS } = opts;
  let pipelinePromise = null;
  return async (text) => {
    const prompted = gemmaPrompt(kind, text);
    if (!getWorkerState().disabled) {
      try {
        const full = await embedViaWorker(prompted, { model: GEMMA_MODEL, normalize: false });
        return mrlTruncate(full, dims);
      } catch (err) {
        warnEmbedFallback("gemma", err);
      }
    }
    if (!pipelinePromise) {
      const transformers = await dynamicImport(TRANSFORMERS_PACKAGE2);
      pipelinePromise = transformers.pipeline("feature-extraction", GEMMA_MODEL, {
        session_options: ORT_SESSION_OPTIONS
      });
    }
    const pipe = await pipelinePromise;
    const result = await pipe(prompted, { pooling: "mean", normalize: false });
    return mrlTruncate(Array.from(result.data), dims);
  };
}

// ../../libs/generic/memory/src/qwen3-embedder.ts
var QWEN3_NATIVE_DIMS = CANDIDATE_DIM_SPECS.qwen3.nativeDims;

// ../../libs/generic/memory/src/harrier-embedder.ts
var HARRIER_MODEL = "onnx-community/harrier-oss-v1-0.6b-ONNX";
var HARRIER_NATIVE_DIMS = EMBEDDER_DIM_SPECS.harrier.nativeDims;
var HARRIER_GRAPH_OUTPUT = "sentence_embedding";
var HARRIER_QUERY_TASK = "Given a web search query, retrieve relevant passages that answer the query";
function harrierPrompt(kind, text) {
  return kind === "query" ? `Instruct: ${HARRIER_QUERY_TASK}
Query: ${text}` : text;
}
function assertNativeDims(vec) {
  if (vec.length !== HARRIER_NATIVE_DIMS) {
    throw new Error(`harrier ${HARRIER_GRAPH_OUTPUT}: expected ${HARRIER_NATIVE_DIMS} dims, got ${vec.length}`);
  }
  return vec;
}
var TRANSFORMERS_PACKAGE3 = "@huggingface/transformers";
function buildHarrierEmbedder(opts) {
  const { kind, dims = HARRIER_NATIVE_DIMS } = opts;
  let pipelinePromise = null;
  return async (text) => {
    const prompted = harrierPrompt(kind, text);
    if (!getWorkerState().disabled) {
      try {
        const full = await embedViaWorker(prompted, {
          model: HARRIER_MODEL,
          output: HARRIER_GRAPH_OUTPUT
        });
        return mrlTruncate(assertNativeDims(full), dims);
      } catch (err) {
        warnEmbedFallback("harrier", err);
      }
    }
    if (!pipelinePromise) {
      const transformers = await dynamicImport(TRANSFORMERS_PACKAGE3);
      pipelinePromise = transformers.pipeline("feature-extraction", HARRIER_MODEL, {
        session_options: ORT_SESSION_OPTIONS
      });
    }
    const pipe = await pipelinePromise;
    const enc = pipe.tokenizer(prompted, { padding: true, truncation: true });
    const out = await pipe.model(enc);
    const tensor = out[HARRIER_GRAPH_OUTPUT];
    if (!tensor) {
      throw new Error(
        `harrier model output '${HARRIER_GRAPH_OUTPUT}' missing (has: ${Object.keys(out).join(", ")})`
      );
    }
    return mrlTruncate(assertNativeDims(Array.from(tensor.data)), dims);
  };
}

// ../../libs/generic/memory/src/sidecar-embedder.ts
var SIDECAR_MAX_TEXT_CHARS = 32e3;

// ../../libs/generic/rerank/src/execution-target.ts
var CPU_EXECUTION_TARGET = Object.freeze({
  device: "cpu",
  dtype: "q8",
  why: "CPU provider: int8 kernels are native on x86, weights are ~4x smaller, and q8 preserves the ranking head (D-006)"
});
var CUDA_EXECUTION_TARGET = Object.freeze({
  device: "cuda",
  dtype: "fp16",
  why: "CUDA provider: fp16 is native on the GPU, halves bandwidth, and avoids the int8 quantisation error entirely"
});
var WEBGPU_EXECUTION_TARGET = Object.freeze({
  device: "webgpu",
  dtype: "fp16",
  why: "WebGPU provider: fp16 is the native shader format"
});
var RERANK_DEVICE_ENV = "PAPERCUSP_RERANK_DEVICE";
function resolveExecutionTarget(env = typeof process === "undefined" ? {} : process.env) {
  const raw = (env[RERANK_DEVICE_ENV] ?? "").trim().toLowerCase();
  if (raw === "cuda" || raw === "gpu") return CUDA_EXECUTION_TARGET;
  if (raw === "webgpu") return WEBGPU_EXECUTION_TARGET;
  return CPU_EXECUTION_TARGET;
}

// ../../libs/generic/rerank/src/local-reranker-worker.ts
import { Worker as Worker2 } from "node:worker_threads";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { resolve as resolve2, dirname as dirname2 } from "node:path";
var _worker2 = null;
var _workerReady2 = null;
var _nextId2 = 0;
var _pending2 = /* @__PURE__ */ new Map();
var _workerDisabled2 = false;
var _beforeExitHookInstalled2 = false;
var _beforeExitListener2 = null;
var _refd2 = false;
function syncWorkerRef2() {
  const want = _pending2.size > 0;
  if (!_worker2 || want === _refd2) return;
  if (want) _worker2.ref();
  else _worker2.unref();
  _refd2 = want;
}
function workerPath2() {
  const here = typeof __filename !== "undefined" ? __filename : fileURLToPath2(import.meta.url);
  return resolve2(dirname2(here), "local-reranker-worker.script.mjs");
}
function ensureWorker2() {
  if (_workerDisabled2) return Promise.reject(new Error("rerank worker disabled"));
  if (_workerReady2) return _workerReady2;
  _workerReady2 = new Promise((resolveReady, rejectReady) => {
    try {
      _worker2 = new Worker2(workerPath2());
    } catch (err) {
      _workerDisabled2 = true;
      _workerReady2 = null;
      rejectReady(err);
      return;
    }
    let initialized = false;
    _worker2.on(
      "message",
      (msg) => {
        if (msg.kind === "ready") {
          initialized = true;
          _refd2 = true;
          syncWorkerRef2();
          installBeforeExitHook2();
          resolveReady();
          return;
        }
        if (typeof msg.id !== "number") return;
        const p = _pending2.get(msg.id);
        if (!p) return;
        _pending2.delete(msg.id);
        syncWorkerRef2();
        if (msg.kind === "score_ok" && Array.isArray(msg.scores)) p.resolve(msg.scores);
        else p.reject(new Error(msg.error ?? "rerank worker error"));
      }
    );
    _worker2.on("error", (err) => {
      for (const [, p] of _pending2) p.reject(err);
      _pending2.clear();
      _worker2 = null;
      _workerReady2 = null;
      _refd2 = false;
      if (!initialized) rejectReady(err);
    });
    _worker2.on("exit", (code) => {
      if (code !== 0 && !initialized) {
        rejectReady(new Error(`rerank worker exited with code ${code} before ready`));
      }
      for (const [, p] of _pending2) p.reject(new Error(`rerank worker exited with code ${code}`));
      _pending2.clear();
      _worker2 = null;
      _workerReady2 = null;
      _refd2 = false;
    });
  }).catch((err) => {
    _workerReady2 = null;
    throw err;
  });
  return _workerReady2;
}
async function scoreViaWorker(req) {
  await ensureWorker2();
  if (!_worker2) throw new Error("rerank worker not initialized");
  const id = _nextId2++;
  return new Promise((resolveScore, rejectScore) => {
    _pending2.set(id, { resolve: resolveScore, reject: rejectScore });
    syncWorkerRef2();
    _worker2.postMessage({ kind: "score", id, ...req });
  });
}
async function shutdownLocalReranker() {
  if (_worker2) {
    try {
      await _worker2.terminate();
    } catch {
    }
  }
  _worker2 = null;
  _workerReady2 = null;
  _workerDisabled2 = false;
  _refd2 = false;
  _pending2.clear();
  _nextId2 = 0;
}
function installBeforeExitHook2() {
  if (_beforeExitHookInstalled2) return;
  _beforeExitHookInstalled2 = true;
  _beforeExitListener2 = async () => {
    if (_pending2.size > 0) return;
    await shutdownLocalReranker();
  };
  process.on("beforeExit", _beforeExitListener2);
}
function getRerankWorkerState() {
  return {
    alive: _worker2 !== null,
    disabled: _workerDisabled2,
    pendingCount: _pending2.size,
    keepAlive: _refd2
  };
}
var _lastFallbackWarnAt2 = 0;
var FALLBACK_WARN_COOLDOWN_MS2 = 3e4;
function warnRerankFallback(err) {
  const now = Date.now();
  if (now - _lastFallbackWarnAt2 < FALLBACK_WARN_COOLDOWN_MS2) return;
  _lastFallbackWarnAt2 = now;
  if (process.env.NODE_ENV !== "test") {
    console.warn(
      `[rerank] worker path failed \u2014 falling back to inline (main-thread, blocks the event loop) for this call, so the timeout bound is only accurate to one batch: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ../../libs/generic/rerank/src/scorer-gate.ts
var RerankDeadlineError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "RerankDeadlineError";
  }
};
function isDeadlineFailure(err) {
  if (err instanceof RerankDeadlineError) return true;
  return err instanceof Error && /deadline exceeded/.test(err.message);
}
var RERANK_MAX_CONCURRENT_ENV = "RERANK_MAX_CONCURRENT_SCORERS";
var _maxConcurrent = null;
var _active = 0;
var _activePairs = 0;
var _queue = [];
var _msPerPair = null;
var _observations = 0;
function maxConcurrent() {
  if (_maxConcurrent !== null) return _maxConcurrent;
  const raw = Number(process.env[RERANK_MAX_CONCURRENT_ENV]);
  _maxConcurrent = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  return _maxConcurrent;
}
function estimatedWaitMs(pairs) {
  if (_msPerPair === null) return null;
  const backlog = _activePairs + _queue.reduce((n, w) => n + w.pairs, 0);
  return (backlog + pairs) * _msPerPair;
}
function wouldMissDeadline(pairs, deadline) {
  if (deadline === void 0) return false;
  const wait = estimatedWaitMs(pairs);
  if (wait === null) return false;
  return Date.now() + wait > deadline;
}
function shedError(pairs, deadline) {
  const wait = Math.round(estimatedWaitMs(pairs) ?? 0);
  const budget = Math.max(0, deadline - Date.now());
  return new RerankDeadlineError(
    `rerank: scoring deadline exceeded after 0 of ${pairs} pairs \u2014 the shared scorer is ${_active} deep with ${_queue.length} queued, so this call needs ~${wait}ms against ${budget}ms of budget. Shedding now rather than spending the budget waiting.`
  );
}
function pump() {
  while (_queue.length > 0 && _active < maxConcurrent()) {
    const w = _queue.shift();
    if (w.deadline !== void 0 && wouldMissDeadline(w.pairs, w.deadline)) {
      w.refuse(shedError(w.pairs, w.deadline));
      continue;
    }
    _active++;
    _activePairs += w.pairs;
    w.admit();
  }
}
async function runInScorerGate(pairs, deadline, fn) {
  if (pairs <= 0) return await fn();
  if (deadline !== void 0 && wouldMissDeadline(pairs, deadline)) {
    throw shedError(pairs, deadline);
  }
  await new Promise((admit, refuse) => {
    _queue.push({ pairs, deadline, admit, refuse });
    pump();
  });
  const startedAt = Date.now();
  const soloRun = _active === 1;
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - startedAt;
    _active--;
    _activePairs -= pairs;
    if (soloRun && elapsed > 0) {
      _observations++;
      if (_observations > 1) {
        const sample = elapsed / pairs;
        _msPerPair = _msPerPair === null ? sample : _msPerPair * 0.7 + sample * 0.3;
      }
    }
    pump();
  }
}

// ../../libs/generic/rerank/src/local-engine.ts
var LOCAL_RERANKER_MODEL = "Alibaba-NLP/gte-reranker-modernbert-base";
var FAST_RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
var ORT_SESSION_OPTIONS2 = { intraOpNumThreads: 4, interOpNumThreads: 1 };
var DEFAULT_MAX_LENGTH = 512;
var DEFAULT_BATCH_SIZE = 16;
var TRANSFORMERS_PACKAGE4 = "@huggingface/transformers";
var dynamicImport2 = new Function("specifier", "return import(specifier)");
var _models = /* @__PURE__ */ new Map();
var _loaderOverride = null;
var _workerWithLoaderForTest = false;
async function defaultLoader(model, dtype, device) {
  const transformers = await dynamicImport2(TRANSFORMERS_PACKAGE4);
  const [tokenizer, classifier] = await Promise.all([
    transformers.AutoTokenizer.from_pretrained(model),
    transformers.AutoModelForSequenceClassification.from_pretrained(model, {
      dtype,
      device,
      session_options: ORT_SESSION_OPTIONS2
    })
  ]);
  return { tokenizer, model: classifier };
}
function loadCrossEncoder(opts = {}) {
  return loadOnTarget(opts.model ?? LOCAL_RERANKER_MODEL, effectiveTarget(opts));
}
function effectiveTarget(opts) {
  const host = resolveExecutionTarget();
  if (opts.device === void 0 && opts.dtype === void 0) return host;
  const device = opts.device ?? host.device;
  const dtype = opts.dtype ?? host.dtype;
  return { device, dtype, why: "explicit caller override" };
}
var _gpuUnusable = false;
function reportDemotion(target, err) {
  console.warn(
    `[rerank] ${target.device}/${target.dtype} session failed to construct \u2014 falling back to ${CPU_EXECUTION_TARGET.device}/${CPU_EXECUTION_TARGET.dtype}. Reranking continues on CPU. Cause: ${String(err?.message ?? err).slice(0, 200)}`
  );
}
function loadOnTarget(model, target) {
  const effective = target.device !== "cpu" && _gpuUnusable ? CPU_EXECUTION_TARGET : target;
  const key = `${model}::${effective.dtype}::${effective.device}`;
  const cached = _models.get(key);
  if (cached) return cached;
  const loading = (_loaderOverride ?? defaultLoader)(model, effective.dtype, effective.device).catch(
    (err) => {
      _models.delete(key);
      if (effective.device === "cpu") throw err;
      _gpuUnusable = true;
      reportDemotion(effective, err);
      return loadOnTarget(model, CPU_EXECUTION_TARGET);
    }
  );
  _models.set(key, loading);
  return loading;
}
function activeExecutionTarget() {
  const host = resolveExecutionTarget();
  return host.device !== "cpu" && _gpuUnusable ? CPU_EXECUTION_TARGET : host;
}
var sigmoid = (x) => 1 / (1 + Math.exp(-x));
function scoreFromLogits(row) {
  if (row.length === 1) return sigmoid(row[0]);
  const [negative, positive] = row;
  return sigmoid(positive - negative);
}
function yieldToEventLoop() {
  return new Promise((resolve3) => {
    if (typeof setImmediate === "function") setImmediate(resolve3);
    else setTimeout(resolve3, 0);
  });
}
async function scoreCrossEncoderInline(query, texts, opts = {}) {
  if (texts.length === 0) return [];
  const { tokenizer, model } = await loadCrossEncoder(opts);
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const { deadline } = opts;
  const scores = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    await yieldToEventLoop();
    if (deadline !== void 0 && Date.now() >= deadline) {
      throw new Error(
        `rerank: scoring deadline exceeded after ${start} of ${texts.length} pairs \u2014 degrading to retrieval order`
      );
    }
    const batch = texts.slice(start, start + batchSize);
    const inputs = tokenizer(
      // The cross-encoder scores a PAIR: the query is repeated against each doc.
      new Array(batch.length).fill(query),
      { text_pair: batch, padding: true, truncation: true, max_length: maxLength }
    );
    const { logits } = await model(inputs);
    const numLabels = logits.dims.length > 1 ? logits.dims[logits.dims.length - 1] : 1;
    if (logits.data.length !== batch.length * numLabels) {
      throw new Error(
        `rerank: logits length ${logits.data.length} != ${batch.length} pairs x ${numLabels} labels`
      );
    }
    for (let i = 0; i < batch.length; i++) {
      const row = [];
      for (let l = 0; l < numLabels; l++) row.push(Number(logits.data[i * numLabels + l]));
      scores.push(scoreFromLogits(row));
    }
  }
  return scores;
}
async function scoreCrossEncoder(query, texts, opts = {}) {
  if (texts.length === 0) return [];
  return await runInScorerGate(
    texts.length,
    opts.deadline,
    () => scoreCrossEncoderUngated(query, texts, opts)
  );
}
async function scoreCrossEncoderUngated(query, texts, opts) {
  if ((_loaderOverride === null || _workerWithLoaderForTest) && !getRerankWorkerState().disabled) {
    const target = effectiveTarget(opts);
    const effective = target.device !== "cpu" && _gpuUnusable ? CPU_EXECUTION_TARGET : target;
    try {
      return await scoreViaWorker({
        query,
        texts,
        model: opts.model ?? LOCAL_RERANKER_MODEL,
        dtype: effective.dtype,
        device: effective.device,
        maxLength: opts.maxLength ?? DEFAULT_MAX_LENGTH,
        batchSize: Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE),
        deadline: opts.deadline
      });
    } catch (err) {
      if (isDeadlineFailure(err)) throw err;
      warnRerankFallback(err);
    }
  }
  return await scoreCrossEncoderInline(query, texts, opts);
}

// ../../libs/generic/rerank/src/index.ts
var SCORE_TIMEOUT = Symbol("rerank-score-timeout");

// ../../packages/operator-core/lib/memory/embed-sidecar-server.ts
var EMBED_SIDECAR_DEFAULT_PORT = 3384;
var EMBED_SIDECAR_PORT_ENV = "PAPERCUSP_EMBED_SIDECAR_PORT";
var EMBED_SIDECAR_WARM_ENV = "PAPERCUSP_EMBED_SIDECAR_WARM";
var EMBED_SIDECAR_READY_LINE = "PAPERCUSP_EMBED_SIDECAR_READY";
var MAX_TEXTS_PER_CALL = 256;
var MAX_TEXT_CHARS = SIDECAR_MAX_TEXT_CHARS;
var MAX_BODY_BYTES = 16 * 1024 * 1024;
var EMBED_CACHE_MAX_DEFAULT = 1024;
var EMBED_SIDECAR_CONCURRENCY_ENV = "PAPERCUSP_EMBED_SIDECAR_CONCURRENCY";
var EMBED_SIDECAR_MODELS = ["gemma", "local", "harrier"];
var EMBED_SIDECAR_RUNTIME = "node-onnx-worker";
var EMBED_SIDECAR_CAP_HEALTHZ = "GET /healthz";
var EMBED_SIDECAR_CAP_EMBED = "POST /embed";
var EMBED_SIDECAR_CAP_RERANK = "POST /rerank";
var MODEL_REVS = {
  gemma: GEMMA_MODEL,
  local: LOCAL_EMBEDDER_MODEL,
  harrier: HARRIER_MODEL
};
var RERANK_SIDECAR_MODELS = ["rerank", "rerank-fast"];
var RERANK_MODEL_REVS = {
  rerank: LOCAL_RERANKER_MODEL,
  "rerank-fast": FAST_RERANKER_MODEL
};
function validateRerankRequest(body) {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const b = body;
  const model = b.model === void 0 ? "rerank" : b.model;
  if (!RERANK_SIDECAR_MODELS.includes(model)) {
    return { error: `unknown model '${String(model)}' \u2014 expected one of: ${RERANK_SIDECAR_MODELS.join(", ")}` };
  }
  if (typeof b.query !== "string" || b.query.trim() === "") {
    return { error: "query must be a non-empty string" };
  }
  if (b.query.length > MAX_TEXT_CHARS) {
    return { error: `query exceeds ${MAX_TEXT_CHARS} chars (got ${b.query.length}) \u2014 truncate before reranking` };
  }
  if (!Array.isArray(b.texts) || b.texts.length === 0) {
    return { error: "texts must be a non-empty array of strings" };
  }
  if (b.texts.length > MAX_TEXTS_PER_CALL) {
    return { error: `texts exceeds the ${MAX_TEXTS_PER_CALL}-per-call cap (got ${b.texts.length}) \u2014 split the batch` };
  }
  for (let i = 0; i < b.texts.length; i++) {
    const t = b.texts[i];
    if (typeof t !== "string") return { error: `texts[${i}] is not a string` };
    if (t.length > MAX_TEXT_CHARS) {
      return { error: `texts[${i}] exceeds ${MAX_TEXT_CHARS} chars (got ${t.length}) \u2014 truncate before reranking` };
    }
  }
  return { model, query: b.query, texts: b.texts };
}
function validateEmbedRequest(body) {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const b = body;
  const model = b.model === void 0 ? "gemma" : b.model;
  if (!EMBED_SIDECAR_MODELS.includes(model)) {
    return { error: `unknown model '${String(model)}' \u2014 expected one of: ${EMBED_SIDECAR_MODELS.join(", ")}` };
  }
  if (b.kind !== "query" && b.kind !== "document") {
    return { error: `kind must be 'query' or 'document' (got '${String(b.kind)}')` };
  }
  if (!Array.isArray(b.texts) || b.texts.length === 0) {
    return { error: "texts must be a non-empty array of strings" };
  }
  if (b.texts.length > MAX_TEXTS_PER_CALL) {
    return { error: `texts exceeds the ${MAX_TEXTS_PER_CALL}-per-call cap (got ${b.texts.length}) \u2014 split the batch` };
  }
  for (let i = 0; i < b.texts.length; i++) {
    const t = b.texts[i];
    if (typeof t !== "string") return { error: `texts[${i}] is not a string` };
    if (t.length > MAX_TEXT_CHARS) {
      return { error: `texts[${i}] exceeds ${MAX_TEXT_CHARS} chars (got ${t.length}) \u2014 truncate before embedding` };
    }
  }
  return { model, kind: b.kind, texts: b.texts };
}
var warmTokens = (env) => (env[EMBED_SIDECAR_WARM_ENV] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
function resolveWarmModels(env = process.env) {
  const tokens = warmTokens(env);
  if (tokens.length === 0) return ["gemma"];
  const embedders = [
    ...new Set(tokens.filter((s) => EMBED_SIDECAR_MODELS.includes(s)))
  ];
  if (embedders.length > 0) return embedders;
  const namedAReranker = tokens.some((s) => RERANK_SIDECAR_MODELS.includes(s));
  return namedAReranker ? [] : ["gemma"];
}
function resolveWarmRerankers(env = process.env) {
  return [
    ...new Set(
      warmTokens(env).filter(
        (s) => RERANK_SIDECAR_MODELS.includes(s)
      )
    )
  ];
}
var defaultBuilders = {
  gemma: (kind) => Promise.resolve(buildGemmaEmbedder({ kind })),
  // BGE is symmetric: one embedder serves both kinds (buildLocalEmbedder has
  // no kind knob), so both registry slots resolve to the same closure.
  local: () => buildLocalEmbedder(),
  // harrier-oss-0.6b @ native-1024 (P-014): pooling+normalize live in the
  // ONNX graph itself; kind picks the instruct-vs-raw prompt.
  harrier: (kind) => Promise.resolve(buildHarrierEmbedder({ kind }))
};
var buildSidecarReranker = (model) => async () => {
  await loadCrossEncoder({ model });
  return (query, texts) => scoreCrossEncoder(query, texts, { model });
};
var defaultRerankBuilders = {
  rerank: buildSidecarReranker(LOCAL_RERANKER_MODEL),
  "rerank-fast": buildSidecarReranker(FAST_RERANKER_MODEL)
};
var defaultWorkerStates = {
  embedder: getWorkerState,
  reranker: getRerankWorkerState
};
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}
var SidecarRequestAbortedError = class extends Error {
  constructor() {
    super("request_aborted");
    this.name = "AbortError";
  }
};
function trackRequestCancellation(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const onRequestAborted = () => abort();
  const onRequestClose = () => {
    if (!req.complete) abort();
  };
  const onResponseClose = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", onRequestAborted);
  req.once("close", onRequestClose);
  res.once("close", onResponseClose);
  return {
    signal: controller.signal,
    dispose: () => {
      req.off("aborted", onRequestAborted);
      req.off("close", onRequestClose);
      res.off("close", onResponseClose);
    }
  };
}
function readBody(req, signal) {
  return new Promise((resolve3, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => finish(reject, new SidecarRequestAbortedError());
    const onData = (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish(reject, new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => finish(resolve3, Buffer.concat(chunks).toString("utf8"));
    const onError = (error) => finish(reject, error);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function createEmbedSidecarServer(opts = {}) {
  const builders = opts.builders ?? defaultBuilders;
  const rerankBuilders = opts.rerankBuilders ?? defaultRerankBuilders;
  const log = opts.log ?? ((line) => console.log(line));
  const workerStates = opts.workerStates ?? defaultWorkerStates;
  const port = opts.port ?? Number(process.env[EMBED_SIDECAR_PORT_ENV] ?? EMBED_SIDECAR_DEFAULT_PORT);
  const startedAt = Date.now();
  const embedders = /* @__PURE__ */ new Map();
  const warm = {};
  const getEmbedder = (model, kind) => {
    const key = `${model}:${kind}`;
    let p = embedders.get(key);
    if (!p) {
      warm[key] = "warming";
      p = builders[model](kind).then(
        (fn) => {
          warm[key] = "warm";
          return fn;
        },
        (err) => {
          warm[key] = "failed";
          embedders.delete(key);
          throw err;
        }
      );
      embedders.set(key, p);
    }
    return p;
  };
  const rerankers = /* @__PURE__ */ new Map();
  const getReranker = (model) => {
    let p = rerankers.get(model);
    if (!p) {
      warm[model] = "warming";
      p = rerankBuilders[model]().then(
        (fn) => {
          warm[model] = "warm";
          return fn;
        },
        (err) => {
          warm[model] = "failed";
          rerankers.delete(model);
          throw err;
        }
      );
      rerankers.set(model, p);
    }
    return p;
  };
  const concurrency = Math.max(
    1,
    Math.floor(
      opts.concurrency ?? (Number(process.env[EMBED_SIDECAR_CONCURRENCY_ENV]) > 0 ? Number(process.env[EMBED_SIDECAR_CONCURRENCY_ENV]) : 1)
    )
  );
  let active = 0;
  const waiting = [];
  function drainQueue() {
    while (active < concurrency && waiting.length > 0) {
      const next = waiting.shift();
      if (next.started || next.settled) continue;
      next.start();
    }
  }
  const scheduleDrain = () => {
    setTimeout(drainQueue, 5);
  };
  const enqueue = (work) => {
    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve3, reject) => {
      resolveTask = resolve3;
      rejectTask = reject;
    });
    const entry = {
      started: false,
      settled: false,
      start: () => {
        if (entry.started || entry.settled) return;
        entry.started = true;
        active++;
        Promise.resolve().then(work).then(resolveTask, rejectTask).finally(() => {
          active--;
          scheduleDrain();
        });
      },
      cancel: () => {
        if (entry.started || entry.settled) return false;
        const index = waiting.indexOf(entry);
        if (index < 0) return false;
        waiting.splice(index, 1);
        entry.settled = true;
        rejectTask(new SidecarRequestAbortedError());
        return true;
      }
    };
    if (active < concurrency) entry.start();
    else waiting.push(entry);
    return { promise, cancel: entry.cancel };
  };
  const cacheMax = opts.cacheMax ?? EMBED_CACHE_MAX_DEFAULT;
  const vecCache = /* @__PURE__ */ new Map();
  const inflight = /* @__PURE__ */ new Map();
  let cacheHits = 0;
  let cacheMisses = 0;
  const cacheGet = (key) => {
    const hit = vecCache.get(key);
    if (hit) {
      vecCache.delete(key);
      vecCache.set(key, hit);
    }
    return hit;
  };
  const cachePut = (key, vec) => {
    if (cacheMax <= 0) return;
    vecCache.delete(key);
    vecCache.set(key, vec);
    while (vecCache.size > cacheMax) {
      const oldest = vecCache.keys().next().value;
      if (oldest === void 0) break;
      vecCache.delete(oldest);
    }
  };
  const computeCached = (key, work, signal) => {
    if (signal.aborted) return Promise.reject(new SidecarRequestAbortedError());
    const cached = cacheGet(key);
    if (cached) {
      cacheHits++;
      return Promise.resolve(cached);
    }
    let entry = inflight.get(key);
    if (entry) {
      cacheHits++;
    } else {
      cacheMisses++;
      entry = { task: enqueue(work), consumers: 0 };
      inflight.set(key, entry);
      const owned2 = entry;
      void owned2.task.promise.then(
        (value) => {
          if (owned2.consumers > 0) cachePut(key, value);
        },
        () => {
        }
      ).finally(() => {
        if (inflight.get(key) === owned2) inflight.delete(key);
      });
    }
    const owned = entry;
    owned.consumers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      owned.consumers--;
      if (owned.consumers === 0 && owned.task.cancel() && inflight.get(key) === owned) {
        inflight.delete(key);
      }
    };
    return new Promise((resolve3, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        release();
        reject(new SidecarRequestAbortedError());
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      owned.task.promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          release();
          resolve3(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          release();
          reject(error);
        }
      );
    });
  };
  const embedOneCached = (model, kind, text, signal) => computeCached(`${model}:${kind}\0${text}`, async () => {
    const embed = await getEmbedder(model, kind);
    return embed(text);
  }, signal);
  const rerankOneCached = (model, query, text, signal) => computeCached(`${model}\0${query}\0${text}`, async () => {
    const rerankFn = await getReranker(model);
    const scores = await rerankFn(query, [text]);
    if (scores.length !== 1 || typeof scores[0] !== "number" || !Number.isFinite(scores[0])) {
      throw new Error(`reranker returned a bad score for one pair: ${JSON.stringify(scores)}`);
    }
    return [scores[0]];
  }, signal).then((boxed) => boxed[0]);
  const handleEmbed = async (req, res, signal) => {
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req, signal));
    } catch (e) {
      if (signal.aborted || res.destroyed || res.writableEnded) return;
      json(res, 400, { error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const v = validateEmbedRequest(parsed);
    if ("error" in v) {
      json(res, 400, { error: v.error });
      return;
    }
    try {
      const vectors = await Promise.all(
        v.texts.map((text) => embedOneCached(v.model, v.kind, text, signal))
      );
      const body = {
        vectors,
        dims: vectors[0]?.length ?? 0,
        runtime: EMBED_SIDECAR_RUNTIME,
        modelRev: MODEL_REVS[v.model]
      };
      json(res, 200, body);
    } catch (e) {
      if (signal.aborted || res.destroyed || res.writableEnded) return;
      json(res, 500, { error: `embed_failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const handleRerank = async (req, res, signal) => {
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req, signal));
    } catch (e) {
      if (signal.aborted || res.destroyed || res.writableEnded) return;
      json(res, 400, { error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const v = validateRerankRequest(parsed);
    if ("error" in v) {
      json(res, 400, { error: v.error });
      return;
    }
    try {
      const scores = await Promise.all(v.texts.map((text) => rerankOneCached(v.model, v.query, text, signal)));
      const body = {
        scores,
        runtime: EMBED_SIDECAR_RUNTIME,
        modelRev: RERANK_MODEL_REVS[v.model]
      };
      json(res, 200, body);
    } catch (e) {
      if (signal.aborted || res.destroyed || res.writableEnded) return;
      json(res, 500, { error: `rerank_failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const withRequestCancellation = (handler) => (req, res) => {
    const cancellation = trackRequestCancellation(req, res);
    void handler(req, res, cancellation.signal).finally(cancellation.dispose);
  };
  const handlers = {
    [EMBED_SIDECAR_CAP_HEALTHZ]: (_req, res) => {
      json(res, 200, {
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        runtime: EMBED_SIDECAR_RUNTIME,
        // Everything this build can serve. A client compares its REQUIRED
        // capabilities against this before adopting the process.
        capabilities,
        models: { ...warm },
        // The (device, dtype) pair reranking is ACTUALLY running on \u2014 not the
        // one requested. A GPU host whose CUDA provider failed to load is
        // demoted to cpu/q8 silently as far as search is concerned (the engine
        // is fail-safe by design), so this is where that shows up. Before the
        // first load it reports the host's resolved target. See plan D-006.
        rerankExecution: activeExecutionTarget(),
        // WI-37696: the two worker-thread crash-breakers THIS process owns.
        //
        // Both the embedder (@papercusp/memory) and the cross-encoder
        // (@papercusp/rerank) run their model in a persistent worker thread and
        // fall back to INLINE main-thread work when it is unavailable. Each has
        // a `disabled` latch that, once tripped, is permanent for the process \u2014
        // and because the fallback returns identical values, tripping it emits
        // no error, no log line and no exit code. The sidecar keeps answering
        // 200 while the one thing it exists for (a warm model OFF the request
        // thread) is silently gone, and every /rerank then blocks this loop for
        // the duration of a forward pass.
        //
        // This is the correct process to report it from: the state is module-
        // global, these workers spawn HERE (not in the operator host), and the
        // getters are imported from the SAME bare specifier the embedders and
        // rerankers above use, so this reads the live module record rather than
        // a second, pristine copy. `disabled: true` is the field to alert on.
        //
        // Report-only \u2014 `ok` stays true. A fallen-back sidecar is degraded, not
        // down; it still returns correct vectors and scores, so failing the
        // health check would tell a supervisor to restart a process that is
        // serving every request correctly.
        workers: {
          embedder: workerStates.embedder(),
          reranker: workerStates.reranker()
        },
        cache: { hits: cacheHits, misses: cacheMisses, size: vecCache.size },
        concurrency
      });
    },
    [EMBED_SIDECAR_CAP_EMBED]: withRequestCancellation(handleEmbed),
    [EMBED_SIDECAR_CAP_RERANK]: withRequestCancellation(handleRerank)
  };
  const capabilities = Object.keys(handlers);
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    const handle = handlers[`${req.method} ${url}`];
    if (handle) {
      handle(req, res);
      return;
    }
    json(res, 404, { error: `no route ${req.method} ${url}` });
  });
  const listening = new Promise((resolve3, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve3(typeof addr === "object" && addr ? addr.port : port);
    });
  });
  if (opts.warmAtBoot !== false) {
    void listening.then(() => {
      for (const model of resolveWarmModels()) {
        for (const kind of ["document", "query"]) {
          getEmbedder(model, kind).then((embed) => embed("warm-up")).then(() => log(`[embed-sidecar] ${model}:${kind} warm`)).catch((e) => log(`[embed-sidecar] ${model}:${kind} warm-up failed: ${e instanceof Error ? e.message : e}`));
        }
      }
      for (const model of resolveWarmRerankers()) {
        getReranker(model).then((rerankFn) => rerankFn("warm-up", ["warm-up"])).then(() => log(`[embed-sidecar] ${model} warm`)).catch((e) => log(`[embed-sidecar] ${model} warm-up failed: ${e instanceof Error ? e.message : e}`));
      }
    });
  }
  return {
    server,
    listening,
    warmStates: () => ({ ...warm }),
    close: () => new Promise((resolve3) => {
      server.close(() => resolve3());
    })
  };
}
function runEmbedSidecarServer() {
  const handle = createEmbedSidecarServer();
  handle.listening.then(
    (port) => {
      console.log(`[embed-sidecar] listening on http://127.0.0.1:${port}`);
      console.log(`${EMBED_SIDECAR_READY_LINE} port=${port}`);
    },
    (err) => {
      console.error("[embed-sidecar] failed to listen:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  );
  const shutdown = (signal) => {
    console.log(`[embed-sidecar] ${signal} received, shutting down gracefully`);
    void handle.close().then(() => Promise.allSettled([shutdownLocalEmbedder(), shutdownLocalReranker()])).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// bin/embed-sidecar.ts
var invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) runEmbedSidecarServer();
