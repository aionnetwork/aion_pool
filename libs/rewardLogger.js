const {createLogger, format, transports} = require('winston');
const {printf} = format;

module.exports = function () {
    const logFormat = printf(info => {
        return `${info.message}`;
    });

    const logger = createLogger({
        level: 'info',
        format: logFormat,
        transports: [
            new transports.File({filename: 'logs/rewards.log', level: 'info'}),
        ]
    });

    this.log = function (message) {
        logger.log({
            level: 'info',
            message: message
        });
    }
};