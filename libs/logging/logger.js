const dateFormat = require('dateformat');
const winston = require('winston');
const {createLogger, format, transports} = require('winston');
const {printf} = format;
require('winston-daily-rotate-file');

const severityValues = {
    'debug': 4,
    'warning': 3,
    'error': 2,
    'special': 1
};

const severityColors = {
    'debug': 'blue',
    'warning': 'yellow',
    'error': 'red',
    'special': 'red'
};

const toWinstonLevel = function (level) {
    switch (level) {
        case 'warning':
            return 'warn';
        case 'special':
            return 'silly';
        default:
            return level;
    }
};

module.exports = function (configuration) {
    const logLevelInt = severityValues[configuration.logLevel];

    const logFormat = winston.format.combine(
        winston.format.printf(info => `${info.level}: ${info.message}`)
    );

    const transport = new (transports.DailyRotateFile)({
        dirname: 'logs',
        filename: 'aion-pool.%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
    });

    const logger = createLogger({
        level: configuration.logLevel,
        format: logFormat,
        transports: [
            new transports.Console({colorize: true}),
            new transports.File({filename: 'logs/error.log', level: 'error'}),
            transport
        ]
    });

    const log = function (severity, system, component, text, subcat) {
        if (severityValues[severity] < logLevelInt)
            return;
        if (subcat) {
            let realText = subcat;
            let realSubCat = text;
            text = realText;
            subcat = realSubCat
        }
        let logString,
            entryDesc = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss') + ' [' + system + ']\t';
        logString = entryDesc + '[' + component + '] ';
        if (subcat) {
            logString += '(' + subcat + ') ';
        }
        logString += text;

        logger.log({
            level: toWinstonLevel(severity),
            message: logString
        });
    };

    let _this = this;
    Object.keys(severityValues).forEach((logType) => {
        _this[logType] = function () {
            let args = Array.prototype.slice.call(arguments, 0);
            args.unshift(logType);
            log.apply(this, args);
        }
    });
};