import React, { createContext, useContext, useReducer, useMemo, useCallback, useEffect, useState } from 'react'
import { HOURLY_PAIR_RATES, GET_BLOCKS } from '../apollo/queries'

import { kuniswap, blockClient } from '../apollo/client'

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { useBlockNumber } from '../state/application/hooks'
import { timeframeOptions } from '../constants'

dayjs.extend(utc)

const PairDataContext = createContext()

const UPDATE_HOURLY_DATA = 'UPDATE_HOURLY_DATA'

function usePairDataContext() {
    return useContext(PairDataContext)
}

const getHourlyRateData = async (pairAddress, startTime, latestBlock) => {
    try {
        const utcEndTime = dayjs.utc()
        let time = startTime

        // create an array of hour start times until we reach current hour
        const timestamps = []
        while (time <= utcEndTime.unix() - 3600) {
            timestamps.push(time)
            time += 3600
        }

        // backout if invalid timestamp format
        if (timestamps.length === 0) {
            return []
        }

        // once you have all the timestamps, get the blocks for each timestamp in a bulk query
        let blocks

        blocks = await getBlocksFromTimestamps(timestamps, 100)

        console.log(blocks)

        // catch failing case
        if (!blocks || blocks?.length === 0) {
            return []
        }

        if (latestBlock) {
            blocks = blocks.filter(b => {
                return parseFloat(b.number) <= parseFloat(latestBlock)
            })
        }

        const result = await splitQuery(HOURLY_PAIR_RATES, kuniswap, [pairAddress], blocks, 100)

        // format token ETH price results
        let values = []
        for (var row in result) {
            let timestamp = row.split('t')[1]
            if (timestamp) {
                values.push({
                    timestamp,
                    rate0: parseFloat(result[row]?.token0Price),
                    rate1: parseFloat(result[row]?.token1Price)
                })
            }
        }

        let formattedHistoryRate0 = []
        let formattedHistoryRate1 = []

        // for each hour, construct the open and close price
        for (let i = 0; i < values.length - 1; i++) {
            formattedHistoryRate0.push({
                timestamp: values[i].timestamp,
                open: parseFloat(values[i].rate0),
                close: parseFloat(values[i + 1].rate0)
            })
            formattedHistoryRate1.push({
                timestamp: values[i].timestamp,
                open: parseFloat(values[i].rate1),
                close: parseFloat(values[i + 1].rate1)
            })
        }

        return [formattedHistoryRate0, formattedHistoryRate1]
    } catch (e) {
        console.log(e)
        return [[], []]
    }
}

/**
 * @notice Fetches block objects for an array of timestamps.
 * @dev blocks are returned in chronological order (ASC) regardless of input.
 * @dev blocks are returned at string representations of Int
 * @dev timestamps are returns as they were provided; not the block time.
 * @param {Array} timestamps
 */
export async function getBlocksFromTimestamps(timestamps, skipCount = 500) {
    if (timestamps?.length === 0) {
        return []
    }

    let fetchedData = await splitQuery(GET_BLOCKS, blockClient, [], timestamps, skipCount)

    let blocks = []
    if (fetchedData) {
        for (var t in fetchedData) {
            if (fetchedData[t].length > 0) {
                blocks.push({
                    timestamp: t.split('t')[1],
                    number: fetchedData[t][0]['number']
                })
            }
        }
    }

    console.log(blocks)
    return blocks
}

export async function splitQuery(query, localClient, vars, list, skipCount = 100) {
    let fetchedData = {}
    let allFound = false
    let skip = 0

    while (!allFound) {
        let end = list.length
        if (skip + skipCount < list.length) {
            end = skip + skipCount
        }
        let sliced = list.slice(skip, end)
        let result = await localClient.query({
            query: query(...vars, sliced),
            fetchPolicy: 'cache-first'
        })
        fetchedData = {
            ...fetchedData,
            ...result.data
        }
        if (Object.keys(result.data).length < skipCount || skip + skipCount > list.length) {
            allFound = true
        } else {
            skip += skipCount
        }
    }

    return fetchedData
}

function reducer(state, { type, payload }) {
    switch (type) {
        case UPDATE_HOURLY_DATA: {
            const { address, hourlyData, timeWindow } = payload
            return {
                ...state,
                [address]: {
                    ...state?.[address],
                    hourlyData: {
                        ...state?.[address]?.hourlyData,
                        [timeWindow]: hourlyData
                    }
                }
            }
        }

        default: {
            throw Error(`Unexpected action type in DataContext reducer: '${type}'.`)
        }
    }
}

export default function Provider({ children }) {
    const [state, dispatch] = useReducer(reducer, {})

    const updateHourlyData = useCallback((address, hourlyData, timeWindow) => {
        dispatch({
            type: UPDATE_HOURLY_DATA,
            payload: { address, hourlyData, timeWindow }
        })
    }, [])

    return (
        <PairDataContext.Provider value={useMemo(() => [state, updateHourlyData], [state, updateHourlyData])}>
            {children}
        </PairDataContext.Provider>
    )
}

export function useHourlyRateData(pairAddress, timeWindow) {
    const [state, { updateHourlyData }] = usePairDataContext()
    const chartData = state?.[pairAddress]?.hourlyData?.[timeWindow]
    const latestBlock = useBlockNumber()

    useEffect(() => {
        const currentTime = dayjs.utc()
        console.log(dayjs.utc)
        const windowSize = timeWindow === timeframeOptions.MONTH ? 'month' : 'week'
        const startTime =
            timeWindow === timeframeOptions.ALL_TIME
                ? 1589760000
                : currentTime
                      .subtract(1, windowSize)
                      .startOf('hour')
                      .unix()

        console.log(startTime)

        async function fetch() {
            let data = await getHourlyRateData(pairAddress, startTime, latestBlock)
            updateHourlyData(pairAddress, data, timeWindow)
        }
        if (!chartData) {
            fetch()
        }
    }, [chartData, timeWindow, pairAddress, latestBlock])

    return chartData
}
