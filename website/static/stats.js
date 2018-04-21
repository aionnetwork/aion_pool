var poolWorkerData;
var poolHashrateData;
var poolBlockData;

var poolWorkerChart;
var poolHashrateChart;
var poolBlockChart;
var poolPercentChart;

var statData;
var poolKeys;

var units = [ ' Sol/s', ' KSol/s', ' MSol/s', ' GSol/s', ' TSol/s', ' PSol/s' ];

function buildChartData(){

    var pools = {};

    poolKeys = [];
    for (var i = 0; i < statData.length; i++){
        for (var pool in statData[i].pools){
            if (poolKeys.indexOf(pool) === -1)
                poolKeys.push(pool);
        }
    }


    for (var i = 0; i < statData.length; i++){

        var time = statData[i].time * 1000;

        for (var f = 0; f < poolKeys.length; f++){
            var pName = poolKeys[f];
            var a = pools[pName] = (pools[pName] || {
                hashrate: [],
                percent: [],
                workers: [],
                blocks: []
            });
            if (pName in statData[i].pools){
                a.hashrate.push([time, statData[i].pools[pName].hashrate]);
                a.percent.push([time, statData[i].pools[pName].percent]);
                a.workers.push([time, statData[i].pools[pName].workerCount]);
                a.blocks.push([time, statData[i].pools[pName].blocks.pending])
            }
            else{
                a.hashrate.push([time, 0]);
                a.percent.push([time, 0]);
                a.workers.push([time, 0]);
                a.blocks.push([time, 0])
            }

        }
    }

    poolWorkerData = [];
    poolHashrateData = [];
    poolPercentData = [];
    poolBlockData = [];

    console.log(statData);

    for (var pool in pools){
        poolWorkerData.push({
            key: pool,
            values: pools[pool].workers
        });
        poolHashrateData.push({
            key: pool,
            values: pools[pool].hashrate
        });
        poolPercentData.push({
            key: pool,
            values: pools[pool].percent
        });
        poolBlockData.push({
            key: pool,
            values: pools[pool].blocks
        })
    }
}

function getReadableHashRateString(number) {
        // what tier? (determines prefix)
        var tier = Math.log10(number) / 3 | 0;

        // get prefix and determine scale
        var prefix = units[tier];
        var scale = Math.pow(10, tier * 3);

        // scale the number
        var scaled = number / scale;

        // format number and add prefix as suffix
        return scaled.toFixed(2) + prefix;
    }
/*
function getReadableHashRateString(hashrate){
    hashrate = (hashrate * 2);
    if (hashrate < 1000000) {
        return (Math.round(hashrate / 1000) / 1000 ).toFixed(2)+' Sol/s';
    }
    var byteUnits = [ ' Sol/s', ' KSol/s', ' MSol/s', ' GSol/s', ' TSol/s', ' PSol/s' ];
    var i = Math.floor((Math.log(hashrate/100000) / Math.log(1000)) - 1) || 0;
    hashrate = (hashrate/100000) / Math.pow(1000, i + 1);
    return hashrate.toFixed(2) + byteUnits[i];
}*/

function timeOfDayFormat(timestamp){
    var dStr = d3.time.format('%I:%M %p')(new Date(timestamp));
    if (dStr.indexOf('0') === 0) dStr = dStr.slice(1);
    return dStr;
}

function displayCharts(){

    nv.addGraph(function() {
        poolWorkerChart = nv.models.stackedAreaChart()
            .margin({left: 40, right: 40})
            .x(function(d){ return d[0] })
            .y(function(d){ return d[1] })
            .useInteractiveGuideline(true)
            .clipEdge(true);

        poolWorkerChart.xAxis.tickFormat(timeOfDayFormat);

        poolWorkerChart.yAxis.tickFormat(d3.format('d'));

        d3.select('#poolWorkers').datum(poolWorkerData).call(poolWorkerChart);

        return poolWorkerChart;
    });


    nv.addGraph(function() {
        poolHashrateChart = nv.models.lineChart()
            .margin({left: 100, right: 40})
            .x(function(d){ return d[0] })
            .y(function(d){ return d[1] })
            .useInteractiveGuideline(true);

        poolHashrateChart.xAxis.tickFormat(timeOfDayFormat);

        poolHashrateChart.yAxis.tickFormat(function(d){
            return getReadableHashRateString(d);
        });

        d3.select('#poolHashrate').datum(poolHashrateData).call(poolHashrateChart);

        return poolHashrateChart;
    });

    console.log(poolPercentData)

    nv.addGraph(function() {
        poolPercentChart = nv.models.lineChart()
            .margin({left: 100, right: 40})
            .x(function(d){ return d[0] })
            .y(function(d){ return d[1] })
            .useInteractiveGuideline(true);

        poolPercentChart.xAxis.tickFormat(timeOfDayFormat);

        poolPercentChart.yAxis.tickFormat(d3.format(".0%"));

        d3.select('#poolPercent').datum(poolPercentData).call(poolPercentChart);

        return poolPercentChart;
    });


    nv.addGraph(function() {
        poolBlockChart = nv.models.multiBarChart()
            .x(function(d){ return d[0] })
            .y(function(d){ return d[1] });

        poolBlockChart.xAxis.tickFormat(timeOfDayFormat);

        poolBlockChart.yAxis.tickFormat(d3.format('d'));

        d3.select('#poolBlocks').datum(poolBlockData).call(poolBlockChart);

        return poolBlockChart;
    });
}

function TriggerChartUpdates(){
    poolWorkerChart.update();
    poolHashrateChart.update();
    poolBlockChart.update();
}

nv.utils.windowResize(TriggerChartUpdates);

$.getJSON('/api/pool_stats', function(data){
    statData = data;
    buildChartData();
    displayCharts();
});

statsSource.addEventListener('message', function(e){
    var stats = JSON.parse(e.data);
    statData.push(stats);


    var newPoolAdded = (function(){
        for (var p in stats.pools){
            if (poolKeys.indexOf(p) === -1)
                return true;
        }
        return false;
    })();

    if (newPoolAdded || Object.keys(stats.pools).length > poolKeys.length){
        buildChartData();
        displayCharts();
    }
    else {
        var time = stats.time * 1000;
        for (var f = 0; f < poolKeys.length; f++) {
            var pool =  poolKeys[f];
            for (var i = 0; i < poolWorkerData.length; i++) {
                if (poolWorkerData[i].key === pool) {
                    poolWorkerData[i].values.shift();
                    poolWorkerData[i].values.push([time, pool in stats.pools ? stats.pools[pool].workerCount : 0]);
                    break;
                }
            }
            for (var i = 0; i < poolHashrateData.length; i++) {
                if (poolHashrateData[i].key === pool) {
                    poolHashrateData[i].values.shift();
                    poolHashrateData[i].values.push([time, pool in stats.pools ? stats.pools[pool].hashrate : 0]);
                    break;
                }
            }
            for (var i = 0; i < poolBlockData.length; i++) {
                if (poolBlockData[i].key === pool) {
                    poolBlockData[i].values.shift();
                    poolBlockData[i].values.push([time, pool in stats.pools ? stats.pools[pool].blocks.pending : 0]);
                    break;
                }
            }
        }
        TriggerChartUpdates();
    }


});